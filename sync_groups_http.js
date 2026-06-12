import { getApi, autoLogin } from "./src/core/zalo-client.js";
import { getDb, upsertMessage } from "./src/core/db.js";
import { extractMessageText } from "./src/utils/extract-message-text.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    const db = getDb();
    
    if (!db) {
        console.error("Database not initialized");
        process.exit(1);
    }
    
    // Fetch 50 groups
    const groups = db.prepare("SELECT group_id, name FROM groups LIMIT 50").all();
    console.log(`PULLING HTTP HISTORY FOR ${groups.length} GROUPS...`);
    
    let totalSynced = 0;
    for (const group of groups) {
        try {
            const history = await api.getGroupChatHistory(group.group_id, 20);
            const msgs = history?.groupMsgs || [];
            if (msgs.length > 0) {
                console.log(`- Group "${group.name}" (${group.group_id}): fetched ${msgs.length} messages.`);
                for (const msg of msgs) {
                    const msgId = msg.msgId || msg.data?.msgId;
                    if (!msgId) continue;
                    
                    const text = typeof msg.content === "string" ? msg.content : extractMessageText(msg.content, msg.type);
                    const msgType = typeof msg.content === "string" ? "text" : msg.type || "attachment";
                    
                    upsertMessage({
                        msgId: msgId,
                        threadId: group.group_id,
                        senderId: msg.uidFrom || null,
                        senderName: msg.dName || null,
                        ts: msg.ts ? Number(msg.ts) : Date.now(),
                        fromMe: msg.isSelf ? 1 : 0,
                        text,
                        msgType,
                        contentJson: JSON.stringify(msg.data || msg),
                        recalled: msg.recalled ?? 0,
                    });
                    totalSynced++;
                }
            }
        } catch (err) {
            // Silence JSON parse errors or other errors for individual groups
        }
    }
    
    console.log(`Group HTTP sync complete! Total group messages inserted: ${totalSynced}`);
    
    // Check local database counts again
    const msgCount = db.prepare("SELECT count(*) as count FROM messages").get().count;
    console.log(`Messages in database now: ${msgCount}`);
    
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
