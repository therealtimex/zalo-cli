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
    
    console.log(`Testing DM endpoints for: ${friend.display_name} (${friend.user_id})`);
    
    const chatHost = api.zpwServiceMap.chat[0]; // https://tt-chat4-wpa.chat.zalo.me
    const key = ctx.secretKey;
    
    const paths = [
        "/api/message/list",
        "/api/message/get",
        "/api/message/recent",
        "/api/message/history",
        "/api/message/chat",
        "/api/message/load",
        "/api/message/sync"
    ];
    
    for (const path of paths) {
        const url = `${chatHost}${path}`;
        console.log(`\nTrying URL: ${url}`);
        try {
            const params = {
                toid: friend.user_id,
                count: 10,
            };
            const encodedParams = encodeAES(key, JSON.stringify(params));
            const finalUrl = `${url}?params=${encodeURIComponent(encodedParams)}&zpw_ver=${ctx.API_VERSION}&zpw_type=${ctx.API_TYPE}`;
            
            const cookieStr = await ctx.cookie.getCookieString(url);
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
