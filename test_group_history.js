import { getApi, autoLogin } from "./src/core/zalo-client.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    
    console.log("Connecting listener...");
    await new Promise((resolve, reject) => {
        api.listener.on("connected", resolve);
        api.listener.start({ retryOnClose: false });
    });
    console.log("Listener connected. Waiting 2 seconds...");
    await new Promise(r => setTimeout(r, 2000));

    api.listener.on("old_messages", (msgs, type) => {
        console.log("old_messages event fired! msgs length:", msgs?.length, "type:", type);
        if (msgs && msgs.length > 0) {
            console.log("Sample message content:", msgs[0].data?.content);
        }
    });

    console.log("Requesting old messages for Groups (type 1)...");
    api.listener.requestOldMessages(1, null);

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
