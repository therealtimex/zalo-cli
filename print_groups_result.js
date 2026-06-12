import { getApi, autoLogin } from "./src/core/zalo-client.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    const result = await api.getAllGroups();
    console.log("getAllGroups result keys:", Object.keys(result || {}));
    if (result) {
        console.log("gridVerMap keys count:", Object.keys(result.gridVerMap || {}).length);
        // print a sample entry if any other fields exist
        const sampleKey = Object.keys(result)[0];
        console.log("Sample field from result:", sampleKey, JSON.stringify(result[sampleKey]).slice(0, 500));
    }
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
