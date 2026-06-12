import { getApi, autoLogin } from "./src/core/zalo-client.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    
    console.log("Connecting listener...");
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Connection timeout")), 15000);
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
    console.log("Listener connected.");

    api.listener.on("old_messages", (msgs, type) => {
        console.log("old_messages event fired! msgs length:", msgs?.length, "type:", type);
        if (msgs && msgs.length > 0) {
            console.log("Sample message data:", JSON.stringify(msgs[0], null, 2));
        }
    });

    api.listener.on("error", (err) => {
        console.error("Listener error:", err);
    });

    console.log("Requesting old messages for DMs...");
    api.listener.requestOldMessages(0, null);

    // Wait 8 seconds
    await new Promise(r => setTimeout(r, 8000));
    console.log("Done waiting.");
    api.listener.stop();
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
