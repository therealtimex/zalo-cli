import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const tempHome = join(homedir(), ".zalo-agent-cli-test-temp-downloader");
process.env.ZALO_CONFIG_DIR = tempHome;

// Dynamically import media-downloader so process.env.ZALO_CONFIG_DIR is set beforehand
const { getMediaInfo, downloadAttachment } = await import("./media-downloader.js");

describe("Media Downloader Utility", () => {
    beforeEach(() => {
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    afterEach(() => {
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    describe("getMediaInfo", () => {
        it("returns null for non-object content", () => {
            assert.equal(getMediaInfo("plain text message", "text"), null);
            assert.equal(getMediaInfo(null, "image"), null);
        });

        it("extracts url and filename from different image/file structures", () => {
            const imgContent = {
                href: "https://zalo.cdn/img.jpg",
                name: "photo.jpg",
            };
            const info = getMediaInfo(imgContent, "image");
            assert.ok(info);
            assert.equal(info.url, "https://zalo.cdn/img.jpg");
            assert.equal(info.filename, "photo.jpg");
            assert.equal(info.subfolder, "images");
        });

        it("extracts subfolder types correctly based on msgType", () => {
            const fileContent = { url: "https://zalo.cdn/doc.pdf", title: "report.pdf" };
            const voiceContent = { thumbUrl: "https://zalo.cdn/voice.amr", filename: "recording.amr" };
            const stickerContent = { originalUrl: "https://zalo.cdn/sticker.png", name: "sticker" };

            assert.equal(getMediaInfo(fileContent, "file").subfolder, "files");
            assert.equal(getMediaInfo(voiceContent, "voice").subfolder, "voice");
            assert.equal(getMediaInfo(stickerContent, "sticker").subfolder, "stickers");
        });

        it("cleans up filenames to prevent path traversal", () => {
            const badContent = {
                url: "https://zalo.cdn/malicious",
                name: "../../etc/passwd",
            };
            const info = getMediaInfo(badContent, "file");
            assert.ok(info);
            assert.equal(info.filename, ".._.._etc_passwd");
        });
    });

    describe("downloadAttachment", () => {
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it("downloads file stream and sets correct file permissions", async () => {
            // Mock global fetch
            globalThis.fetch = async (url) => {
                return {
                    ok: true,
                    status: 200,
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(Buffer.from("simulated file data"));
                            controller.close();
                        },
                    }),
                };
            };

            const ownId = "user_download_test";
            const msgId = "msg_12345";
            const localPath = await downloadAttachment(
                ownId,
                msgId,
                "images",
                "https://zalo.cdn/test.jpg",
                "test.jpg"
            );

            // Verify file exists
            assert.ok(fs.existsSync(localPath), "Downloaded file should exist on disk");
            const content = fs.readFileSync(localPath, "utf-8");
            assert.equal(content, "simulated file data");

            // Verify directory and file permissions
            const dirStats = fs.statSync(join(tempHome, "accounts", ownId, "media", "images"));
            assert.equal(dirStats.mode & 0o777, 0o700, "Directory permissions should be 0700");

            const fileStats = fs.statSync(localPath);
            assert.equal(fileStats.mode & 0o777, 0o600, "File permissions should be 0600");
        });

        it("throws error for non-ok HTTP responses", async () => {
            globalThis.fetch = async (url) => {
                return {
                    ok: false,
                    status: 404,
                };
            };

            await assert.rejects(
                downloadAttachment("user_download_test", "msg_fail", "images", "https://zalo.cdn/404.jpg", "404.jpg"),
                /HTTP error 404 fetching/
            );
        });
    });
});
