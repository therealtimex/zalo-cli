import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";

const ownId = "1567422059325573042";
const dbPath = join(homedir(), ".zalo-agent-cli", "accounts", ownId, "zalo.db");

console.log("Checking DB at path:", dbPath);

try {
    const db = new Database(dbPath, { readonly: true });
    
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log("Tables in database:", tables.map(t => t.name).join(", "));
    
    for (const table of tables) {
        try {
            const count = db.prepare(`SELECT count(*) as count FROM ${table.name}`).get().count;
            console.log(`Table ${table.name} has ${count} row(s)`);
        } catch (e) {
            console.error(`Failed to count table ${table.name}:`, e.message);
        }
    }
    
    console.log("\nSample chats:");
    const chats = db.prepare("SELECT * FROM chats LIMIT 5").all();
    console.log(chats);

    console.log("\nSample contacts:");
    const contacts = db.prepare("SELECT * FROM contacts LIMIT 5").all();
    console.log(contacts);

    console.log("\nSample messages:");
    const messages = db.prepare("SELECT * FROM messages LIMIT 5").all();
    console.log(messages);

} catch (e) {
    console.error("Failed to read database:", e.message);
}
