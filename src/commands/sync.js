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
import { normalizeTimestamp, timestampOrNow } from "../utils/time.js";

export function persistHistoryMessage(msg, { allowedThreadIds = null } = {}) {
    const msgId = msg.data?.msgId;
    if (!msgId) return false;

    const threadId = String(msg.threadId || "");
    if (allowedThreadIds && !allowedThreadIds.has(threadId)) return false;

    const text =
        typeof msg.data?.content === "string"
            ? msg.data.content
            : extractMessageText(msg.data?.content, msg.data?.msgType);
    const msgType = typeof msg.data?.content === "string" ? "text" : msg.data?.msgType || "attachment";

    upsertMessage({
        msgId,
        threadId: msg.threadId,
        senderId: msg.data?.uidFrom || null,
        senderName: msg.data?.dName || null,
        ts: timestampOrNow(msg.data?.ts),
        fromMe: msg.isSelf ? 1 : 0,
        text,
        msgType,
        contentJson: JSON.stringify(msg.data),
        recalled: msg.data?.recalled ?? 0,
    });
    return true;
}

export async function waitForListenerConnected(api, timeoutMs = 15000) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            api.listener.removeListener("connected", onConnected);
            api.listener.removeListener("error", onError);
            reject(new Error("Listener connection timeout"));
        }, timeoutMs);
        const onConnected = () => {
            clearTimeout(timer);
            api.listener.removeListener("error", onError);
            resolve();
        };
        const onError = (err) => {
            clearTimeout(timer);
            api.listener.removeListener("connected", onConnected);
            reject(err);
        };
        api.listener.on("connected", onConnected);
        api.listener.on("error", onError);
        api.listener.start({ retryOnClose: false });
    });
}

export async function requestOldMessagesPage(api, threadType, lastMsgId, timeoutMs) {
    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            api.listener.removeListener("old_messages", handler);
            resolve([]);
        }, timeoutMs);
        const handler = (messages, emittedThreadType) => {
            if (emittedThreadType !== undefined && Number(emittedThreadType) !== Number(threadType)) return;
            clearTimeout(timer);
            api.listener.removeListener("old_messages", handler);
            resolve(messages);
        };

        api.listener.on("old_messages", handler);
        api.listener.requestOldMessages(threadType, lastMsgId);
    });
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
        .option("--debug", "Print per-thread sync errors for troubleshooting unofficial Zalo API failures")
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
                            lastActive: normalizeTimestamp(f.lastActionTime),
                        });
                        contactsCount++;
                        if (f.lastActionTime > 0) {
                            upsertChat({
                                threadId: f.userId,
                                type: 0,
                                name: f.displayName || f.zaloName || "?",
                                lastMessageTs: normalizeTimestamp(f.lastActionTime),
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
                                    createdTs: normalizeTimestamp(g.createdTime),
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

                // 1. Sync Group history via HTTP per group (includes both sent and received messages).
                //    Must run before the WS DM session to avoid session strain from the listener.
                if (!jsonMode) info(`Fetching group message history (${groupIds.length} groups, ${delay}ms delay)...`);
                let dmCount = 0;
                let groupMsgsCount = 0;
                let groupsWithMsgs = 0;
                let groupsEmpty = 0;
                let groupsErrored = 0;
                const groupErrors = [];

                for (let gi = 0; gi < groupIds.length; gi++) {
                    const gid = groupIds[gi];
                    if (!jsonMode && gi % 20 === 0 && gi > 0) {
                        info(
                            `  Group history progress: ${gi}/${groupIds.length} (${groupsWithMsgs} with messages, ${groupsErrored} errors)`,
                        );
                    }
                    try {
                        const history = await api.getGroupChatHistory(gid, perThread);
                        const msgs = history?.groupMsgs || [];
                        if (msgs.length === 0) {
                            groupsEmpty++;
                        } else {
                            groupsWithMsgs++;
                        }
                        for (const msg of msgs) {
                            try {
                                if (persistHistoryMessage(msg)) groupMsgsCount++;
                            } catch {}
                        }
                    } catch (e) {
                        groupsErrored++;
                        const summary = { groupId: gid, error: e.message };
                        groupErrors.push(summary);
                        if (!jsonMode && opts.debug) {
                            info(`  Group ${gid} history error: ${e.message}`);
                        }
                    }
                    await new Promise((r) => setTimeout(r, delay));
                }
                if (!jsonMode)
                    info(
                        `  Group history done: ${groupsWithMsgs} with messages, ${groupsEmpty} empty, ${groupsErrored} errors`,
                    );

                // 2. Sync message history via WS global feeds. This also acts as a fallback
                //    when the unofficial per-group HTTP history endpoint fails for this session.
                if (!jsonMode) info("Fetching message history via WebSocket...");
                try {
                    await waitForListenerConnected(api);

                    if (groupIds.length > 0 && groupsErrored > 0) {
                        const allowedGroupIds = new Set(groupIds.map(String));
                        const targetGroupMessages = Math.max(perThread * groupIds.length, perThread);
                        let lastMsgId = null;
                        let wsGroupPages = 0;
                        let done = false;

                        while (!done && groupMsgsCount < targetGroupMessages) {
                            const pageMessages = await requestOldMessagesPage(api, 1, lastMsgId, timeout);

                            if (!pageMessages || pageMessages.length === 0) {
                                done = true;
                                break;
                            }

                            wsGroupPages++;
                            for (const msg of pageMessages) {
                                try {
                                    if (persistHistoryMessage(msg, { allowedThreadIds: allowedGroupIds })) {
                                        groupMsgsCount++;
                                    }
                                } catch {}
                            }

                            const lastMsg = pageMessages[pageMessages.length - 1];
                            const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                            if (!nextId || nextId === lastMsgId) done = true;
                            lastMsgId = nextId;
                        }

                        if (!jsonMode && wsGroupPages > 0) {
                            info(`  WebSocket group history pages received: ${wsGroupPages}`);
                        }
                    }

                    let lastMsgId = null;
                    let done = false;
                    while (!done) {
                        const pageMessages = await requestOldMessagesPage(api, 0, lastMsgId, timeout);

                        if (!pageMessages || pageMessages.length === 0) {
                            done = true;
                            break;
                        }

                        for (const msg of pageMessages) {
                            try {
                                if (persistHistoryMessage(msg)) dmCount++;
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

                output(
                    {
                        synced: true,
                        contacts_synced: contactsCount,
                        groups_synced: groupsCount,
                        messages_synced: dmCount + groupMsgsCount,
                        group_history: { with_messages: groupsWithMsgs, empty: groupsEmpty, errors: groupsErrored },
                        ...(groupErrors.length > 0 && { group_history_errors: groupErrors.slice(0, 20) }),
                        ...(opts.downloadMedia && { media_downloaded: mediaDownloaded }),
                    },
                    jsonMode,
                    () => {
                        success("Sync complete!");
                        info(`Contacts synced: ${contactsCount}`);
                        info(`Group chats synced: ${groupsCount}`);
                        info(`Messages synced: ${dmCount + groupMsgsCount}`);
                        if (opts.downloadMedia) {
                            info(`Media files downloaded: ${mediaDownloaded}`);
                        }
                    },
                );

                process.exit(0);
            } catch (e) {
                try {
                    api.listener.stop();
                } catch {}
                error(`Sync failed: ${e.message}`);
                process.exit(1);
            }
        });
}
