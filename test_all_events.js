import { getApi, autoLogin } from "./src/core/zalo-client.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    
    console.log("Connecting listener...");
    
    // Patch listener to log all emitted events
    const originalEmit = api.listener.emit;
    api.listener.emit = function (event, ...args) {
        console.log(`[EVENT EMITTED] ${event}`);
        if (event === "message") {
            console.log("  Message data:", JSON.stringify(args[0], null, 2));
        } else if (event === "old_messages") {
            console.log(`  Old messages length: ${args[0]?.length}, type: ${args[1]}`);
        } else if (event === "error") {
            console.error("  Error:", args[0]);
        }
        return originalEmit.apply(this, [event, ...args]);
    };

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Connection timeout")), 15000);
        api.listener.on("connected", () => {
            clearTimeout(timer);
            resolve();
        });
        api.listener.start({ retryOnClose: false });
    });
    console.log("Listener connected. Waiting 10 seconds to capture any automatic startup sync data...");

    await new Promise(r => setTimeout(r, 10000));
    console.log("Done waiting. Stopping listener.");
    api.listener.stop();
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
