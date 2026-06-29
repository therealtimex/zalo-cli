/**
 * Conversation commands — pinned, archived, mute, unmute, read, unread, delete.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { getDb, upsertChat, upsertContact, upsertGroup, getLocalChats, isReadonly } from "../core/db.js";
import { normalizeTimestamp } from "../utils/time.js";

function normalizeFriendProfiles(result) {
    const profiles = result?.changed_profiles || result || {};
    return Array.isArray(profiles) ? profiles : Object.values(profiles);
}

export function cacheConversationFriends(result) {
    const db = getDb();
    if (!db || isReadonly()) return;

    for (const friend of normalizeFriendProfiles(result)) {
        upsertContact({
            userId: friend.userId,
            phoneNumber: friend.phoneNumber || null,
            displayName: friend.displayName || null,
            zaloName: friend.zaloName || null,
            avatarUrl: friend.avatar || null,
            isFriend: 1,
            lastActive: normalizeTimestamp(friend.lastActionTime),
        });
        if (friend.lastActionTime > 0) {
            upsertChat({
                threadId: friend.userId,
                type: 0,
                name: friend.displayName || friend.zaloName || "?",
                lastMessageTs: normalizeTimestamp(friend.lastActionTime),
            });
        }
    }
}

export function cacheConversationGroup(groupId, group) {
    const db = getDb();
    if (!db || isReadonly()) return;

    upsertGroup({
        groupId,
        name: group.name,
        ownerId: group.creatorId || null,
        creatorId: group.creatorId || null,
        createdTs: normalizeTimestamp(group.createdTime),
        memberCount: group.totalMember || 0,
    });
}

function getCachedConversations(opts, limit) {
    const db = getDb();
    if (!db) return [];
    return getLocalChats({
        friendsOnly: opts.friendsOnly,
        groupsOnly: opts.groupsOnly,
        limit,
    });
}

export function registerConvCommands(program) {
    const conv = program.command("conv").description("Manage conversations");

    conv.command("recent")
        .description("List recent conversations with thread_id (friends + groups)")
        .option("-n, --limit <n>", "Max results per type", "20")
        .option("--friends-only", "Show only friend conversations")
        .option("--groups-only", "Show only group conversations")
        .action(async (opts) => {
            try {
                const api = getApi();
                const limit = Number(opts.limit);
                const db = getDb();
                let conversations = [];

                try {
                    // Fetch friends (sorted by lastActionTime = most recent interaction)
                    if (!opts.groupsOnly) {
                        const friends = await api.getAllFriends();
                        const list = normalizeFriendProfiles(friends);
                        try {
                            cacheConversationFriends(friends);
                        } catch {}
                        const sorted = list
                            .filter((f) => f.lastActionTime > 0)
                            .sort((a, b) => b.lastActionTime - a.lastActionTime)
                            .slice(0, limit);
                        for (const f of sorted) {
                            conversations.push({
                                threadId: f.userId,
                                name: f.displayName || f.zaloName || "?",
                                type: "User",
                                typeFlag: 0,
                                lastActive: normalizeTimestamp(f.lastActionTime)
                                    ? new Date(normalizeTimestamp(f.lastActionTime)).toLocaleString()
                                    : "?",
                            });
                        }
                    }

                    // Fetch groups
                    if (!opts.friendsOnly) {
                        const groupsResult = await api.getAllGroups();
                        const groupIds = Object.keys(groupsResult?.gridVerMap || {});
                        if (groupIds.length > 0) {
                            const batchSize = 50;
                            const batches = [];
                            for (let i = 0; i < Math.min(groupIds.length, limit); i += batchSize) {
                                batches.push(groupIds.slice(i, i + batchSize));
                            }
                            for (const batch of batches) {
                                try {
                                    const groupInfo = await api.getGroupInfo(batch);
                                    const map = groupInfo?.gridInfoMap || {};
                                    for (const [gid, g] of Object.entries(map)) {
                                        try {
                                            cacheConversationGroup(gid, g);
                                        } catch {}
                                        conversations.push({
                                            threadId: gid,
                                            name: g.name || "?",
                                            type: "Group",
                                            typeFlag: 1,
                                            memberCount: g.totalMember || 0,
                                        });
                                    }
                                } catch {
                                    // Skip failed batch
                                }
                            }
                        }
                    }

                    if (db) {
                        const cached = getCachedConversations(opts, limit);
                        if (cached.length > 0) {
                            conversations = cached;
                        }
                    }
                } catch (apiErr) {
                    if (db) {
                        warning(`Offline fallback: Zalo API unreachable. Loading from local SQLite cache.`);
                        conversations = getCachedConversations(opts, limit);
                    } else {
                        throw apiErr;
                    }
                }

                output(conversations, program.opts().json, () => {
                    if (conversations.length === 0) {
                        error("No conversations found.");
                        return;
                    }
                    info(`${conversations.length} conversation(s):`);
                    console.log();
                    console.log("  THREAD_ID               TYPE    NAME");
                    console.log("  " + "-".repeat(60));
                    for (const c of conversations) {
                        const typeLabel = c.type === "Group" ? `Group(${c.memberCount || 0})` : "User";
                        const id = c.threadId.padEnd(22);
                        console.log(`  ${id}  ${typeLabel.padEnd(12)}  ${c.name}`);
                    }
                    console.log();
                    info("Use thread_id with messaging commands:");
                    info('  zalo-agent msg send <thread_id> "Hello"           (User)');
                    info('  zalo-agent msg send <thread_id> "Hello" -t 1      (Group)');
                });
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("pinned")
        .description("List pinned conversations")
        .action(async () => {
            try {
                const result = await getApi().getPinnedConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("archived")
        .description("List archived conversations")
        .action(async () => {
            try {
                const result = await getApi().getArchivedConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("mute <threadId>")
        .description("Mute a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-d, --duration <secs>", "Duration in seconds (-1 = forever)", "-1")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().setMute(threadId, Number(opts.type), Number(opts.duration));
                output(result, program.opts().json, () => success("Conversation muted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("unmute <threadId>")
        .description("Unmute a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().setMute(threadId, Number(opts.type), 0);
                output(result, program.opts().json, () => success("Conversation unmuted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("read <threadId>")
        .description("Mark conversation as read")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().sendSeenEvent(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Marked as read"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("unread <threadId>")
        .description("Mark conversation as unread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().markAsUnread(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Marked as unread"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("hidden")
        .description("List hidden conversations")
        .action(async () => {
            try {
                const result = await getApi().getHiddenConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get hidden conversations failed: ${e.message}`);
            }
        });

    conv.command("hide <threadIds...>")
        .description("Hide conversation(s)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadIds, opts) => {
            try {
                const result = await getApi().setHiddenConversations(true, threadIds, Number(opts.type));
                output(result, program.opts().json, () => success(`Hidden ${threadIds.length} conversation(s)`));
            } catch (e) {
                error(`Hide failed: ${e.message}`);
            }
        });

    conv.command("unhide <threadIds...>")
        .description("Unhide conversation(s)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadIds, opts) => {
            try {
                const result = await getApi().setHiddenConversations(false, threadIds, Number(opts.type));
                output(result, program.opts().json, () => success(`Unhidden ${threadIds.length} conversation(s)`));
            } catch (e) {
                error(`Unhide failed: ${e.message}`);
            }
        });

    conv.command("hidden-pin <pin>")
        .description("Set or update PIN for hidden conversations (4 digits)")
        .action(async (pin) => {
            try {
                const result = await getApi().updateHiddenConversPin(pin);
                output(result, program.opts().json, () => success("Hidden conversation PIN updated"));
            } catch (e) {
                error(`Update PIN failed: ${e.message}`);
            }
        });

    conv.command("hidden-pin-reset")
        .description("Reset hidden conversations PIN")
        .action(async () => {
            try {
                const result = await getApi().resetHiddenConversPin();
                output(result, program.opts().json, () => success("Hidden conversation PIN reset"));
            } catch (e) {
                error(`Reset PIN failed: ${e.message}`);
            }
        });

    conv.command("auto-delete-status")
        .description("View auto-delete chat settings")
        .action(async () => {
            try {
                const result = await getApi().getAutoDeleteChat();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get auto-delete status failed: ${e.message}`);
            }
        });

    conv.command("auto-delete <threadId> <ttl>")
        .description("Set auto-delete for a conversation (off, 1d, 7d, 14d)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, ttl, opts) => {
            try {
                const ttlMap = { off: 0, "1d": 86400000, "7d": 604800000, "14d": 1209600000 };
                const ttlValue = ttlMap[ttl];
                if (ttlValue === undefined) {
                    error(`Invalid TTL "${ttl}". Valid: off, 1d, 7d, 14d`);
                    return;
                }
                const result = await getApi().updateAutoDeleteChat(ttlValue, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Auto-delete set to ${ttl} for ${threadId}`));
            } catch (e) {
                error(`Set auto-delete failed: ${e.message}`);
            }
        });

    conv.command("delete <threadId>")
        .description("Delete conversation history")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().deleteConversation(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Conversation deleted"));
            } catch (e) {
                error(e.message);
            }
        });
}
