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
    
    const group = db.prepare("SELECT group_id FROM groups LIMIT 1").get();
    if (!group) {
        console.error("No groups in DB");
        process.exit(1);
    }
    
    const info = await api.getGroupInfo([group.group_id]);
    const map = info?.gridInfoMap || {};
    const g = map[group.group_id];
    console.log("Group Info object:", JSON.stringify(g, null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
