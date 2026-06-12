import { getApi, autoLogin } from "./src/core/zalo-client.js";
import { getDb } from "./src/core/db.js";
import { decodeAES } from "./node_modules/zca-js/dist/utils.js";
import cryptojs from "crypto-js";

function encodeAES(secretKey, data) {
    const key = cryptojs.enc.Base64.parse(secretKey);
    return cryptojs.AES.encrypt(data, key, {
        iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
}

async function main() {
    await autoLogin(true);
    const api = getApi();
    const db = getDb();
    
    if (!db) {
        console.error("Database not initialized");
        process.exit(1);
    }
    
    const ctx = api.getContext();
    const friend = db.prepare("SELECT user_id, display_name FROM contacts LIMIT 1").get();
    if (!friend) {
        console.error("No contacts found in local DB");
        process.exit(1);
    }
    
    console.log(`Testing DM history endpoints for: ${friend.display_name} (${friend.user_id})`);
    
    const chatHost = api.zpwServiceMap.chat[0];
    const key = ctx.secretKey;
    
    const endpoints = [
        { url: `${chatHost}/api/message/history`, paramKey: "toid" },
        { url: `${chatHost}/api/chat/history`, paramKey: "toid" },
        { url: `${chatHost}/api/message/history`, paramKey: "peerId" },
        { url: `${chatHost}/api/friend/history`, paramKey: "fuid" }
    ];
    
    for (const ep of endpoints) {
        console.log(`\nTrying endpoint: ${ep.url} with ${ep.paramKey}`);
        try {
            const params = {
                [ep.paramKey]: friend.user_id,
                count: 10,
            };
            const encodedParams = encodeAES(key, JSON.stringify(params));
            const finalUrl = `${ep.url}?params=${encodeURIComponent(encodedParams)}&zpw_ver=${ctx.API_VERSION}&zpw_type=${ctx.API_TYPE}`;
            
            const cookieStr = await ctx.cookie.getCookieString(ep.url);
            const response = await fetch(finalUrl, {
                headers: {
                    Cookie: cookieStr,
                    "User-Agent": ctx.userAgent,
                }
            });
            
            console.log(`- Status: ${response.status}`);
            const text = await response.text();
            console.log(`- Response body (first 300 chars): ${text.slice(0, 300)}`);
            
            if (response.status === 200 && text.trim().length > 0) {
                try {
                    const json = JSON.parse(text);
                    if (json.data) {
                        const decrypted = decodeAES(key, json.data);
                        console.log(`- Decrypted data: ${decrypted}`);
                    }
                } catch (pe) {
                    console.log(`- Failed to parse/decrypt response: ${pe.message}`);
                }
            }
        } catch (err) {
            console.error(`- Request failed: ${err.message}`);
        }
    }
    
    process.exit(0);
}

main().catch((err) => {
    console.error("Main failed:", err);
    process.exit(1);
});
