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
    
    // Find a group from local DB
    const group = db.prepare("SELECT group_id, name FROM groups LIMIT 1").get();
    if (!group) {
        console.error("No groups found in local DB");
        process.exit(1);
    }
    
    console.log(`Fetching history for group: ${group.name} (${group.group_id})`);
    
    try {
        const history = await api.getGroupChatHistory(group.group_id, 10);
        console.log("Success! History response keys:", Object.keys(history || {}));
        if (history && history.groupMsgs) {
            console.log(`Fetched ${history.groupMsgs.length} messages.`);
            if (history.groupMsgs.length > 0) {
                console.log("Sample message:", JSON.stringify(history.groupMsgs[0], null, 2));
            }
        }
    } catch (err) {
        console.error("Failed to fetch group history:", err);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
