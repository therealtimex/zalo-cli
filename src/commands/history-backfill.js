import { getLocalHistoryCoverage, upsertMessage } from "../core/db.js";
import { extractMessageText } from "../utils/extract-message-text.js";

export function parseBoundedInteger(value, name, defaultValue, { min = 1 } = {}) {
    if (value === undefined || value === null || value === "") return defaultValue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
        throw new Error(`${name} must be an integer greater than or equal to ${min}`);
    }
    return parsed;
}

export function normalizeHistoryThreadType(value) {
    const normalized = String(value ?? "0").toLowerCase();
    if (normalized === "0" || normalized === "dm" || normalized === "user") {
        return { flag: 0, label: "dm" };
    }
    if (normalized === "1" || normalized === "group") {
        return { flag: 1, label: "group" };
    }
    throw new Error("--type must be 0, 1, dm, or group");
}

export function normalizeHistoryBackfillOptions(options = {}) {
    return {
        threadId: String(options.threadId ?? ""),
        threadType: normalizeHistoryThreadType(options.type ?? options.threadType),
        count: parseBoundedInteger(options.count ?? options.limit, "--count", 50),
        requests: parseBoundedInteger(options.requests, "--requests", 1),
        timeout: parseBoundedInteger(options.timeout, "--timeout", 15000),
        delay: parseBoundedInteger(options.delay ?? options.wait, "--delay", 0, { min: 0 }),
    };
}

export function buildHistoryBackfillPlan(options = {}) {
    const normalized = normalizeHistoryBackfillOptions(options);
    if (!normalized.threadId) throw new Error("threadId is required");

    const coverage = getLocalHistoryCoverage({ threadId: normalized.threadId });
    const thread = coverage.threads[0] ?? {
        threadId: normalized.threadId,
        threadName: null,
        threadType: normalized.threadType.label,
        threadTypeFlag: normalized.threadType.flag,
        messageCount: 0,
        oldestTimestamp: null,
        oldestAt: null,
        newestTimestamp: null,
        newestAt: null,
        anchor: {
            usable: false,
            msgId: null,
            actionId: null,
            cursor: null,
            timestamp: null,
            at: null,
        },
        hasHistory: false,
    };
    const status = thread.anchor.usable ? "planned" : "no_history";
    return {
        source: "local",
        local_only: true,
        dry_run: !!options.dryRun,
        status,
        canBackfill: thread.anchor.usable,
        reason: thread.anchor.usable ? null : "no local history anchor is available",
        threadId: normalized.threadId,
        threadType: normalized.threadType.label,
        threadTypeFlag: normalized.threadType.flag,
        bounds: {
            count: normalized.count,
            requests: normalized.requests,
            timeout: normalized.timeout,
            delay: normalized.delay,
        },
        coverage: thread,
        anchor: thread.anchor,
        plannedRequests: thread.anchor.usable ? normalized.requests : 0,
    };
}

function mapZaloHistoryMessage(msg) {
    const content = msg.data?.content;
    const type = typeof content === "string" ? "text" : msg.data?.msgType || "attachment";
    return {
        msgId: msg.data?.msgId,
        threadId: msg.threadId,
        senderId: msg.data?.uidFrom || null,
        senderName: msg.data?.dName || null,
        ts: msg.data?.ts ? Number(msg.data.ts) : Date.now(),
        fromMe: msg.isSelf ? 1 : 0,
        text: typeof content === "string" ? content : extractMessageText(content, msg.data?.msgType),
        msgType: type,
        contentJson: JSON.stringify(msg.data || {}),
        recalled: msg.data?.recalled ?? 0,
        cursor: msg.data?.actionId || msg.data?.msgId || null,
    };
}

function waitForListener(api, timeout) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            api.listener.removeListener("connected", onConnected);
            api.listener.removeListener("error", onError);
            fn(value);
        };
        const onConnected = () => finish(resolve);
        const onError = (err) => finish(reject, err);
        const timer = setTimeout(() => finish(reject, new Error("Listener connection timeout")), timeout);

        api.listener.on("connected", onConnected);
        api.listener.on("error", onError);
        api.listener.start({ retryOnClose: false });
    });
}

function requestOldMessages(api, threadType, cursor, timeout) {
    return new Promise((resolve) => {
        const handler = (messages) => {
            clearTimeout(timer);
            api.listener.removeListener("old_messages", handler);
            resolve({ timedOut: false, messages: messages || [] });
        };
        const timer = setTimeout(() => {
            api.listener.removeListener("old_messages", handler);
            resolve({ timedOut: true, messages: [] });
        }, timeout);

        api.listener.on("old_messages", handler);
        api.listener.requestOldMessages(threadType, cursor);
    });
}

function wait(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHistoryBackfill({ api, options = {}, emitEvent = () => {} }) {
    const plan = buildHistoryBackfillPlan(options);
    emitEvent({ event: "planned", status: plan.status, threadId: plan.threadId, anchor: plan.anchor });

    if (options.dryRun || !plan.canBackfill) {
        return {
            ...plan,
            dry_run: !!options.dryRun,
            completed: plan.status === "planned",
            partial: plan.status !== "planned",
            requestsAttempted: 0,
            messagesSeen: 0,
            messagesMatched: 0,
            messagesStored: 0,
            errors: [],
            limitations: plan.threadType === "dm" ? ["Zalo exposes DM history through WebSocket old-message pagination only"] : [],
        };
    }
    if (!api?.listener) throw new Error("Zalo API listener is required for history backfill");

    const errors = [];
    let cursor = plan.anchor.cursor;
    let requestsAttempted = 0;
    let messagesSeen = 0;
    let messagesMatched = 0;
    let messagesStored = 0;
    let timedOut = false;
    let exhausted = false;

    try {
        await waitForListener(api, plan.bounds.timeout);
        for (let i = 0; i < plan.bounds.requests && messagesMatched < plan.bounds.count; i++) {
            requestsAttempted++;
            emitEvent({ event: "request", request: requestsAttempted, cursor });
            const page = await requestOldMessages(api, plan.threadTypeFlag, cursor, plan.bounds.timeout);
            if (page.timedOut) {
                timedOut = true;
                emitEvent({ event: "timeout", request: requestsAttempted, cursor });
                break;
            }
            if (!page.messages.length) {
                exhausted = true;
                emitEvent({ event: "page", request: requestsAttempted, seen: 0, matched: 0, stored: 0 });
                break;
            }

            messagesSeen += page.messages.length;
            let pageMatched = 0;
            let pageStored = 0;
            let nextCursor = cursor;
            for (const raw of page.messages) {
                const messageThread = String(raw.threadId || "");
                const sender = String(raw.data?.uidFrom || "");
                if (messageThread !== plan.threadId && sender !== plan.threadId) continue;

                const mapped = mapZaloHistoryMessage(raw);
                if (!mapped.msgId) continue;
                pageMatched++;
                if (messagesMatched + pageMatched <= plan.bounds.count) {
                    upsertMessage(mapped);
                    pageStored++;
                }
            }
            messagesMatched += pageMatched;
            messagesStored += pageStored;

            const lastMessage = page.messages[page.messages.length - 1];
            nextCursor = lastMessage?.data?.actionId || lastMessage?.data?.msgId || nextCursor;
            emitEvent({
                event: "page",
                request: requestsAttempted,
                seen: page.messages.length,
                matched: pageMatched,
                stored: pageStored,
                nextCursor,
            });
            if (!nextCursor || nextCursor === cursor) {
                exhausted = true;
                break;
            }
            cursor = nextCursor;
            if (i < plan.bounds.requests - 1) await wait(plan.bounds.delay);
        }
    } catch (e) {
        errors.push(e.message);
        emitEvent({ event: "error", message: e.message });
    } finally {
        try {
            api.listener.stop();
        } catch {}
    }

    const status = errors.length
        ? "error"
        : timedOut
          ? "timeout"
          : messagesStored > 0
            ? "backfilled"
            : exhausted
              ? "exhausted"
              : "partial";
    const partial = status !== "backfilled";
    const result = {
        ...plan,
        dry_run: false,
        local_only: false,
        completed: status === "backfilled" || status === "exhausted",
        partial,
        status,
        requestsAttempted,
        messagesSeen,
        messagesMatched,
        messagesStored,
        errors,
        limitations: plan.threadType === "dm" ? ["Zalo exposes DM history through WebSocket old-message pagination only"] : [],
        nextCursor: cursor,
    };
    emitEvent({ event: "complete", status, messagesStored, requestsAttempted });
    return result;
}
