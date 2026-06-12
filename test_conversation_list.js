import { getApi, autoLogin } from "./src/core/zalo-client.js";
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
    const ctx = api.getContext();
    
    const conversHost = api.zpwServiceMap.conversation[0]; // https://tt-convers-wpa.chat.zalo.me
    const key = ctx.secretKey;
    
    const paths = [
        "/api/convers/list",
        "/api/conversation/list",
        "/api/convers",
        "/api/conversation",
        "/api/convers/recent",
        "/api/convers/get",
        "/api/convers/sync"
    ];
    
    for (const path of paths) {
        const url = `${conversHost}${path}`;
        console.log(`\nTrying URL: ${url}`);
        try {
            const params = {
                imei: ctx.imei,
                count: 20,
            };
            const encryptedParams = encodeAES(key, JSON.stringify(params));
            const finalUrl = `${url}?params=${encodeURIComponent(encryptedParams)}&zpw_ver=${ctx.API_VERSION}&zpw_type=${ctx.API_TYPE}`;
            
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
                        console.log(`- Decrypted data (first 500 chars): ${decrypted.slice(0, 500)}`);
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
