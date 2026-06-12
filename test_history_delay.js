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
        api.listener.start({ retryOnClose: false });
    });
    console.log("Listener connected. Waiting 5 seconds for connection to warm up...");
    await new Promise(r => setTimeout(r, 5000));

    api.listener.on("old_messages", (msgs, type) => {
        console.log("old_messages event fired! msgs length:", msgs?.length, "type:", type);
        if (msgs && msgs.length > 0) {
            console.log("Sample message content:", msgs[0].data?.content);
        }
    });

    console.log("Requesting old messages for DMs (type 0)...");
    api.listener.requestOldMessages(0, null);

    // Wait 5 seconds
    await new Promise(r => setTimeout(r, 5000));
    console.log("Done waiting.");
    api.listener.stop();
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
