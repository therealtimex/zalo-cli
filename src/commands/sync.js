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

export function registerSyncCommand(program) {
    program
        .command("sync")
        .description(
            "Sync all contacts, group chats, and message history into local SQLite cache (requires prior auth)",
        )
        .option("-n, --msg-limit <n>", "Max message count to fetch globally per type (User/Group)", parseInt, 50)
        .option("--timeout <ms>", "Timeout in milliseconds waiting for message history response", parseInt, 15000)
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

                if (!jsonMode) info("Connecting listener to fetch message history...");
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

                const msgLimit = opts.msgLimit;
                const timeout = opts.timeout;

                // 1. Sync User/DM history globally
                if (!jsonMode) info("Fetching DM message history...");
                let lastMsgId = null;
                let done = false;
                let dmCount = 0;
                while (!done && dmCount < msgLimit) {
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
                                msgId: msgId,
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
                            dmCount++;
                        } catch {}
                    }

                    const lastMsg = pageMessages[pageMessages.length - 1];
                    const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                    if (!nextId || nextId === lastMsgId) {
                        done = true;
                    }
                    lastMsgId = nextId;
                }

                // 2. Sync Group history globally
                if (!jsonMode) info("Fetching Group message history...");
                lastMsgId = null;
                done = false;
                let groupMsgsCount = 0;
                while (!done && groupMsgsCount < msgLimit) {
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
                        api.listener.requestOldMessages(1, lastMsgId);
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
                                msgId: msgId,
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

                    const lastMsg = pageMessages[pageMessages.length - 1];
                    const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                    if (!nextId || nextId === lastMsgId) {
                        done = true;
                    }
                    lastMsgId = nextId;
                }

                try {
                    api.listener.stop();
                } catch {}

                let mediaDownloaded = 0;
                if (opts.downloadMedia) {
                    if (!jsonMode) info("Downloading media attachments in background...");
                    const ownId = getOwnId();
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
