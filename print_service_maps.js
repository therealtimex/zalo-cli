import { getApi, autoLogin } from "./src/core/zalo-client.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    const ctx = api.getContext();
    console.log("zpwServiceMap:", JSON.stringify(api.zpwServiceMap, null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
