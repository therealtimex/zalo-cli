/**
 * Sync command — cache all friends, recent group chats, and message history into local SQLite.
 */

import { getApi, getOwnId } from "../core/zalo-client.js";
import { success, error, info, output } from "../utils/output.js";
import {
    getDb,
    upsertContact,
    upsertChat,
    upsertGroup,
    upsertGroupParticipant,
    upsertMessage,
    updateMessageLocalPath,
} from "../core/db.js";
import { extractMessageText } from "../utils/extract-message-text.js";
import { getMediaInfo, downloadAttachment } from "../utils/media-downloader.js";

const GROUP_HISTORY_404_SKIP_THRESHOLD = 3;

export function isHttp404Error(err) {
    const status = err?.status || err?.statusCode || err?.response?.status;
    return status === 404 || /\b404\b/.test(String(err?.message || ""));
}

export function summarizeGroupHistoryBackfill({
    groupCount,
    httpAttempts,
    httpErrors,
    httpMessages,
    wsMessages,
    skippedAfter404,
}) {
    const allHttpAttemptsFailed = httpAttempts > 0 && httpErrors === httpAttempts && httpMessages === 0;
    const hasFallbackMessages = wsMessages > 0;
    const failed = groupCount > 0 && allHttpAttemptsFailed && !hasFallbackMessages;
    const partial =
        !failed && (httpErrors > 0 || skippedAfter404 > 0 || (allHttpAttemptsFailed && hasFallbackMessages));

    return {
        synced: !failed,
        partial,
        history_backfill_reliable: !failed && !partial,
    };
}

export function registerSyncCommand(program) {
    program
        .command("sync")
        .description(
            "Sync all contacts, group chats, and message history into local SQLite cache (requires prior auth)",
        )
        .option(
            "-n, --per-thread <n>",
            "Number of recent messages to fetch per thread (group or DM)",
            (v) => parseInt(v, 10),
            50,
        )
        .option(
            "--delay <ms>",
            "Delay in milliseconds between group history requests to avoid rate limiting",
            (v) => parseInt(v, 10),
            2000,
        )
        .option(
            "--timeout <ms>",
            "Timeout in milliseconds waiting for message history response",
            (v) => parseInt(v, 10),
            15000,
        )
        .option("--download-media", "Download media attachments for synced messages in the background")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            let api;
            try {
                api = getApi();
            } catch (e) {
                error(e.message);
                process.exit(1);
            }

            const db = getDb();
            if (!db) {
                error("Database is not initialized. Make sure you are logged in.");
                process.exit(1);
            }

            try {
                if (!jsonMode) info("Syncing contacts...");
                const friendsResult = await api.getAllFriends();
                const profiles = friendsResult?.changed_profiles || friendsResult || {};
                const friends = Array.isArray(profiles) ? profiles : Object.values(profiles);
                let contactsCount = 0;
                for (const f of friends) {
                    try {
                        upsertContact({
                            userId: f.userId,
                            phoneNumber: f.phoneNumber || null,
                            displayName: f.displayName || null,
                            zaloName: f.zaloName || null,
                            avatarUrl: f.avatar || null,
                            isFriend: 1,
                            lastActive: f.lastActionTime ? f.lastActionTime * 1000 : null,
                        });
                        contactsCount++;
                        if (f.lastActionTime > 0) {
                            upsertChat({
                                threadId: f.userId,
                                type: 0,
                                name: f.displayName || f.zaloName || "?",
                                lastMessageTs: f.lastActionTime * 1000,
                            });
                        }
                    } catch {}
                }
                if (!jsonMode) success(`Synced ${contactsCount} contacts.`);

                if (!jsonMode) info("Syncing group chats...");
                const groupsResult = await api.getAllGroups();
                const groupIds = Object.keys(groupsResult?.gridVerMap || {});
                let groupsCount = 0;
                const batchSize = 50;
                for (let i = 0; i < groupIds.length; i += batchSize) {
                    const batch = groupIds.slice(i, i + batchSize);
                    try {
                        const groupInfo = await api.getGroupInfo(batch);
                        const map = groupInfo?.gridInfoMap || {};
                        for (const [gid, g] of Object.entries(map)) {
                            try {
                                upsertGroup({
                                    groupId: gid,
                                    name: g.name,
                                    ownerId: g.creatorId || null,
                                    creatorId: g.creatorId || null,
                                    createdTs: g.createdTime ? Number(g.createdTime) : null,
                                    memberCount: g.totalMember || 0,
                                });
                                groupsCount++;

                                const members = g.memberIds || {};
                                for (const memberId of Object.keys(members)) {
                                    const role = memberId === g.creatorId ? "owner" : "member";
                                    upsertGroupParticipant(gid, memberId, { role });
                                }
                            } catch {}
                        }
                    } catch {}
                }
                if (!jsonMode) success(`Synced ${groupsCount} group chats.`);

                const perThread = opts.perThread;
                const delay = opts.delay;
                const timeout = opts.timeout;
                const ownId = getOwnId();
                const groupIdSet = new Set(groupIds.map(String));

                // 1. Sync Group history via HTTP per group (includes both sent and received messages).
                //    Must run before the WS DM session to avoid session strain from the listener.
                if (!jsonMode) info(`Fetching group message history (${groupIds.length} groups, ${delay}ms delay)...`);
                let dmCount = 0;
                let groupMsgsCount = 0;
                let wsGroupMsgsCount = 0;
                let groupsWithMsgs = 0;
                let groupsEmpty = 0;
                let groupsErrored = 0;
                let groupHttpAttempts = 0;
                let consecutiveGroup404s = 0;
                let skippedAfter404 = 0;

                for (let gi = 0; gi < groupIds.length; gi++) {
                    const gid = groupIds[gi];
                    if (consecutiveGroup404s >= GROUP_HISTORY_404_SKIP_THRESHOLD) {
                        skippedAfter404 = groupIds.length - gi;
                        if (!jsonMode) {
                            info(
                                `  Skipping remaining ${skippedAfter404} group HTTP history request(s) after ${consecutiveGroup404s} consecutive 404 errors`,
                            );
                        }
                        break;
                    }
                    if (!jsonMode && gi % 20 === 0 && gi > 0) {
                        info(
                            `  Group history progress: ${gi}/${groupIds.length} (${groupsWithMsgs} with messages, ${groupsErrored} errors)`,
                        );
                    }
                    try {
                        groupHttpAttempts++;
                        const history = await api.getGroupChatHistory(gid, perThread);
                        const msgs = history?.groupMsgs || [];
                        consecutiveGroup404s = 0;
                        if (msgs.length === 0) {
                            groupsEmpty++;
                        } else {
                            groupsWithMsgs++;
                        }
                        for (const msg of msgs) {
                            const msgId = msg.data?.msgId;
                            if (!msgId) continue;
                            const text =
                                typeof msg.data?.content === "string"
                                    ? msg.data.content
                                    : extractMessageText(msg.data?.content, msg.data?.msgType);
                            const msgType =
                                typeof msg.data?.content === "string" ? "text" : msg.data?.msgType || "attachment";
                            try {
                                upsertMessage({
                                    msgId,
                                    threadId: msg.threadId,
                                    senderId: msg.data?.uidFrom || null,
                                    senderName: msg.data?.dName || null,
                                    ts: msg.data?.ts ? Number(msg.data.ts) : Date.now(),
                                    fromMe: msg.isSelf ? 1 : 0,
                                    text,
                                    msgType,
                                    contentJson: JSON.stringify(msg.data),
                                    recalled: msg.data?.recalled ?? 0,
                                });
                                groupMsgsCount++;
                            } catch {}
                        }
                    } catch (e) {
                        groupsErrored++;
                        consecutiveGroup404s = isHttp404Error(e) ? consecutiveGroup404s + 1 : 0;
                    }
                    await new Promise((r) => setTimeout(r, delay));
                }
                if (!jsonMode)
                    info(
                        `  Group history done: ${groupsWithMsgs} with messages, ${groupsEmpty} empty, ${groupsErrored} errors`,
                    );

                // 2. Sync DM history via WS global feed (self-sent messages; Zalo has no HTTP
                //    per-friend history endpoint, so received DMs are only available in real-time).
                if (!jsonMode) info("Fetching DM message history via WebSocket...");
                try {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error("Listener connection timeout")), 15000);
                        api.listener.on("connected", () => {
                            clearTimeout(timer);
                            resolve();
                        });
                        api.listener.on("error", (err) => {
                            clearTimeout(timer);
                            reject(err);
                        });
                        api.listener.start({ retryOnClose: false });
                    });

                    let lastMsgId = null;
                    let done = false;
                    while (!done) {
                        const pageMessages = await new Promise((resolve) => {
                            const handler = (messages) => {
                                clearTimeout(timer);
                                api.listener.removeListener("old_messages", handler);
                                resolve(messages);
                            };
                            const timer = setTimeout(() => {
                                api.listener.removeListener("old_messages", handler);
                                resolve([]);
                            }, timeout);
                            api.listener.on("old_messages", handler);
                            api.listener.requestOldMessages(0, lastMsgId);
                        });

                        if (!pageMessages || pageMessages.length === 0) {
                            done = true;
                            break;
                        }

                        for (const msg of pageMessages) {
                            const msgId = msg.data?.msgId;
                            if (!msgId) continue;
                            const text =
                                typeof msg.data?.content === "string"
                                    ? msg.data.content
                                    : extractMessageText(msg.data?.content, msg.data?.msgType);
                            const msgType =
                                typeof msg.data?.content === "string" ? "text" : msg.data?.msgType || "attachment";
                            try {
                                upsertMessage({
                                    msgId,
                                    threadId: msg.threadId,
                                    senderId: msg.data?.uidFrom || null,
                                    senderName: msg.data?.dName || null,
                                    ts: msg.data?.ts ? Number(msg.data.ts) : Date.now(),
                                    fromMe: msg.isSelf ? 1 : 0,
                                    text,
                                    msgType,
                                    contentJson: JSON.stringify(msg.data),
                                    recalled: msg.data?.recalled ?? 0,
                                });
                                if (groupIdSet.has(String(msg.threadId))) {
                                    wsGroupMsgsCount++;
                                } else {
                                    dmCount++;
                                }
                            } catch {}
                        }

                        const lastMsg = pageMessages[pageMessages.length - 1];
                        const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                        if (!nextId || nextId === lastMsgId) done = true;
                        lastMsgId = nextId;
                    }
                } catch (e) {
                    if (!jsonMode) info(`  DM history skipped: ${e.message}`);
                } finally {
                    try {
                        api.listener.stop();
                    } catch {}
                }

                let mediaDownloaded = 0;
                if (opts.downloadMedia) {
                    if (!jsonMode) info("Downloading media attachments in background...");
                    if (ownId) {
                        const rows = db
                            .prepare(
                                `
                            SELECT msg_id, msg_type, content_json 
                            FROM messages 
                            WHERE local_path IS NULL AND recalled = 0 AND msg_type != 'text'
                        `,
                            )
                            .all();

                        for (const row of rows) {
                            let content = null;
                            try {
                                content = JSON.parse(row.content_json);
                            } catch {}
                            if (!content) continue;
                            const mediaInfo = getMediaInfo(content.content || content, row.msg_type);
                            if (!mediaInfo) continue;
                            try {
                                const localPath = await downloadAttachment(
                                    ownId,
                                    row.msg_id,
                                    mediaInfo.subfolder,
                                    mediaInfo.url,
                                    mediaInfo.filename,
                                );
                                updateMessageLocalPath(row.msg_id, localPath);
                                mediaDownloaded++;
                            } catch {}
                        }
                    }
                }

                const groupHistorySummary = summarizeGroupHistoryBackfill({
                    groupCount: groupIds.length,
                    httpAttempts: groupHttpAttempts,
                    httpErrors: groupsErrored,
                    httpMessages: groupMsgsCount,
                    wsMessages: wsGroupMsgsCount,
                    skippedAfter404,
                });
                const totalMessagesSynced = dmCount + groupMsgsCount + wsGroupMsgsCount;

                output(
                    {
                        synced: groupHistorySummary.synced,
                        ...(groupHistorySummary.partial && { partial: true }),
                        contacts_synced: contactsCount,
                        groups_synced: groupsCount,
                        messages_synced: totalMessagesSynced,
                        history_backfill_reliable: groupHistorySummary.history_backfill_reliable,
                        group_history: {
                            with_messages: groupsWithMsgs,
                            empty: groupsEmpty,
                            errors: groupsErrored,
                            http_errors: groupsErrored,
                            http_messages: groupMsgsCount,
                            ws_messages: wsGroupMsgsCount,
                            ...(skippedAfter404 > 0 && { skipped_after_404: skippedAfter404 }),
                        },
                        ...(opts.downloadMedia && { media_downloaded: mediaDownloaded }),
                    },
                    jsonMode,
                    () => {
                        if (groupHistorySummary.synced && !groupHistorySummary.partial) {
                            success("Sync complete!");
                        } else if (groupHistorySummary.partial) {
                            info("Sync partially complete: group HTTP history backfill was incomplete.");
                        } else {
                            error(
                                "Sync failed: group HTTP history failed and no WebSocket fallback messages were synced.",
                            );
                        }
                        info(`Contacts synced: ${contactsCount}`);
                        info(`Group chats synced: ${groupsCount}`);
                        info(`Messages synced: ${totalMessagesSynced}`);
                        if (opts.downloadMedia) {
                            info(`Media files downloaded: ${mediaDownloaded}`);
                        }
                    },
                );

                process.exit(groupHistorySummary.synced ? 0 : 1);
            } catch (e) {
                try {
                    api.listener.stop();
                } catch {}
                error(`Sync failed: ${e.message}`);
                process.exit(1);
            }
        });
}
