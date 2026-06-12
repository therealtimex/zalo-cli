import { getApi, autoLogin } from "./src/core/zalo-client.js";
import { getDb } from "./src/core/db.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    const db = getDb();
    
    if (!db) {
        console.error("Database not initialized");
        process.exit(1);
    }
    
    // Find 10 groups from local DB
    const groups = db.prepare("SELECT group_id, name FROM groups LIMIT 10").all();
    console.log(`Checking history for ${groups.length} groups...`);
    
    for (const group of groups) {
        try {
            const history = await api.getGroupChatHistory(group.group_id, 10);
            const msgCount = history?.groupMsgs?.length ?? 0;
            console.log(`- Group "${group.name}" (${group.group_id}): fetched ${msgCount} messages. More: ${history?.more}`);
            if (msgCount > 0) {
                console.log("  Sample msg type:", history.groupMsgs[0].type, "content preview:", JSON.stringify(history.groupMsgs[0].content || history.groupMsgs[0].data?.content).slice(0, 100));
            }
        } catch (err) {
            console.error(`- Group "${group.name}" failed:`, err.message);
        }
    }
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
