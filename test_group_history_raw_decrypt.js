import { getApi, autoLogin } from "./src/core/zalo-client.js";
import { getDb } from "./src/core/db.js";
import { decodeAES, handleZaloResponse } from "./node_modules/zca-js/dist/utils.js";

async function main() {
    await autoLogin(true);
    const api = getApi();
    const db = getDb();
    
    if (!db) {
        console.error("Database not initialized");
        process.exit(1);
    }
    
    const ctx = api.getContext();
    console.log("Context secretKey:", ctx.secretKey);
    console.log("Context uid:", ctx.uid);

    // Get 2 groups: one that worked (e.g. LiveSpo x RT) and one that failed (e.g. RTA BMC)
    const groups = db.prepare("SELECT group_id, name FROM groups").all();
    console.log(`Found ${groups.length} groups in database.`);
    
    const targetNames = ["LiveSpo x RT", "RTA BMC"];
    for (const name of targetNames) {
        const group = groups.find(g => g.name.includes(name));
        if (!group) {
            console.log(`Could not find group with name containing: ${name}`);
            continue;
        }
        
        console.log(`\n--- Testing group: ${group.name} (${group.group_id}) ---`);
        try {
            // Replicate the API call manually to inspect the raw response
            const serviceURL = `${api.zpwServiceMap.group[0]}/api/group/history`;
            const params = {
                grid: group.group_id,
                count: 10,
            };
            
            // We can construct signed/encrypted request using utils from getGroupChatHistory or similar
            // But let's just intercept handleZaloResponse or make it ourselves.
            // Let's call the api method and inspect what it throws if it fails.
            const history = await api.getGroupChatHistory(group.group_id, 10);
            console.log("History call succeeded! Response:");
            console.log(JSON.stringify(history, null, 2));
        } catch (err) {
            console.error("History call failed:", err);
            
            // Let's trace where it failed. If it failed during fetch, we can check.
            // Let's try to fetch it manually using fetch
            try {
                const url = `${api.zpwServiceMap.group[0]}/api/group/history`;
                const params = {
                    grid: group.group_id,
                    count: 10,
                };
                
                // Let's call encodeAES
                const key = ctx.secretKey;
                const encodedParams = encodeAES(key, JSON.stringify(params));
                const finalUrl = `${url}?params=${encodeURIComponent(encodedParams)}&zpw_ver=${ctx.API_VERSION}&zpw_type=${ctx.API_TYPE}`;
                
                console.log("Fetching raw URL:", finalUrl);
                const cookieStr = await ctx.cookie.getCookieString(url);
                const response = await fetch(finalUrl, {
                    headers: {
                        Cookie: cookieStr,
                        "User-Agent": ctx.userAgent,
                    }
                });
                
                console.log("Response status:", response.status);
                const text = await response.text();
                console.log("Raw Response Body (first 500 chars):", text.slice(0, 500));
                
                if (text.trim().length > 0) {
                    const json = JSON.parse(text);
                    console.log("Response json keys:", Object.keys(json));
                    console.log("Response error_code:", json.error_code);
                    console.log("Response error_message:", json.error_message);
                    if (json.data) {
                        console.log("Response raw encrypted data (first 100 chars):", json.data.slice(0, 100));
                        const decrypted = decodeAES(key, json.data);
                        console.log("Decrypted string (first 500 chars):", decrypted.slice(0, 500));
                    }
                }
            } catch (innerErr) {
                console.error("Manual fetch failed:", innerErr);
            }
        }
    }
    process.exit(0);
}

// Replicate encodeAES from zca-js/dist/utils.js
import cryptojs from "crypto-js";
function encodeAES(secretKey, data) {
    const key = cryptojs.enc.Base64.parse(secretKey);
    return cryptojs.AES.encrypt(data, key, {
        iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
