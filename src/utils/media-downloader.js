import fs from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CONFIG_DIR } from "../core/credentials.js";

/**
 * Extract download URL, filename, and subfolder type from raw message content.
 * @returns {object|null} - { url, filename, subfolder }
 */
export function getMediaInfo(content, msgType) {
    if (!content || typeof content !== "object") return null;

    let url = content.href || content.url || content.thumbUrl || content.originalUrl || content.hdUrl;
    let filename = content.name || content.title || content.filename || "attachment";

    if (!url && content.params) {
        url = content.params.href || content.params.url || content.params.path;
    }

    if (!url) return null;

    // Clean up filename to prevent directory traversal or invalid characters
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    let subfolder = "files";
    const typeLower = String(msgType || "").toLowerCase();
    if (typeLower.includes("image") || typeLower.includes("photo")) {
        subfolder = "images";
    } else if (typeLower.includes("voice") || typeLower.includes("audio")) {
        subfolder = "voice";
    } else if (typeLower.includes("sticker")) {
        subfolder = "stickers";
    }

    return { url, filename, subfolder };
}

/**
 * Download a media attachment to local account storage.
 * @param {string} ownId
 * @param {string} msgId
 * @param {string} subfolder - images | files | voice | stickers
 * @param {string} downloadUrl
 * @param {string} filename
 * @returns {Promise<string>} Local file path
 */
export async function downloadAttachment(ownId, msgId, subfolder, downloadUrl, filename) {
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    const mediaDir = join(accountDir, "media", subfolder);

    // Ensure media directories exist with owner-only permissions
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(mediaDir, 0o700);
    } catch {}

    const localPath = join(mediaDir, `${msgId}_${filename}`);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`HTTP error ${response.status} fetching ${downloadUrl}`);
    }

    const fileStream = fs.createWriteStream(localPath, { mode: 0o600 });
    await new Promise((resolve, reject) => {
        const readable = Readable.fromWeb(response.body);
        readable.pipe(fileStream);
        readable.on("error", reject);
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
    });

    try {
        fs.chmodSync(localPath, 0o600);
    } catch {}

    return localPath;
}
