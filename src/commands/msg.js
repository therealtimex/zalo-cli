/**
 * Message commands — send text, images, files, cards, bank cards, QR transfers,
 * stickers, reactions, delete, forward.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolve } from "path";
import { getApi, getOwnId } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { extractMessageText } from "../utils/extract-message-text.js";
import {
    exportLocalMessages,
    getDb,
    getLocalMessageById,
    getLocalMessageContext,
    getLocalMessages,
    getLocalMessagesCount,
    getLocalStatusBroadcasts,
    listLocalMessages,
    getOldestMessageId,
    searchLocalMessages,
    upsertMessage,
    upsertStatusBroadcast,
    updateMessageLocalPath,
} from "../core/db.js";
import { getMediaInfo, downloadAttachment } from "../utils/media-downloader.js";

/**
 * TextStyle codes matching zca-js TextStyle enum.
 * Used for --style option and markdown parsing.
 */
const TEXT_STYLES = {
    bold: "b",
    b: "b",
    italic: "i",
    i: "i",
    underline: "u",
    u: "u",
    strikethrough: "s",
    s: "s",
    red: "c_db342e",
    orange: "c_f27806",
    yellow: "c_f7b503",
    green: "c_15a85f",
    small: "f_13",
    big: "f_18",
};

/**
 * Parse markdown-like syntax from message text into plain text + styles array.
 * Supports: **bold**, *italic*, __underline__, ~~strikethrough~~,
 *           {red:text}, {orange:text}, {green:text}, {yellow:text},
 *           {big:text}, {small:text}
 */
function parseMarkdownStyles(input) {
    const styles = [];
    let plain = input;

    // Process markdown patterns (order matters: ** before *)
    const patterns = [
        { regex: /\*\*(.+?)\*\*/g, st: "b" },
        { regex: /\*(.+?)\*/g, st: "i" },
        { regex: /__(.+?)__/g, st: "u" },
        { regex: /~~(.+?)~~/g, st: "s" },
        { regex: /\{(red|orange|yellow|green|big|small):(.+?)\}/g, st: null },
    ];

    for (const p of patterns) {
        let match;
        // Re-run from scratch each time since offsets shift
        while ((match = p.regex.exec(plain)) !== null) {
            const fullMatch = match[0];
            const start = match.index;
            let content, st;
            if (p.st === null) {
                // Color/size pattern: {color:text}
                st = TEXT_STYLES[match[1]];
                content = match[2];
            } else {
                st = p.st;
                content = match[1];
            }
            // Replace the markdown syntax with plain content
            plain = plain.slice(0, start) + content + plain.slice(start + fullMatch.length);
            styles.push({ start, len: content.length, st });
            // Reset regex since string changed
            p.regex.lastIndex = start + content.length;
        }
    }

    return { plain, styles };
}

/**
 * Parse manual style specs: "start:len:style" → { start, len, st }
 * Style names: bold, italic, underline, strikethrough, red, orange, yellow, green, big, small
 */
function parseStyleSpecs(specs) {
    return specs
        .map((spec) => {
            const [start, len, style] = spec.split(":");
            const st = TEXT_STYLES[style];
            if (!st) return null;
            return { start: Number(start), len: Number(len), st };
        })
        .filter(Boolean);
}

function firstStringValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== "") {
            return String(value);
        }
    }
    return null;
}

function getSentMessageId(result) {
    return firstStringValue(
        result?.message?.msgId,
        result?.message?.msg_id,
        result?.message?.messageId,
        result?.message?.message_id,
        result?.msgId,
        result?.msg_id,
        result?.messageId,
        result?.message_id,
        result?.data?.msgId,
        result?.data?.msg_id,
        result?.data?.messageId,
        result?.data?.message_id,
    );
}

function buildFallbackMessageId({ ownId, threadId, threadType, text, cliMsgId }) {
    const hash = createHash("sha256")
        .update(
            JSON.stringify({
                ownId: ownId ?? null,
                threadId: threadId ?? null,
                threadType: threadType ?? null,
                text: text ?? null,
                cliMsgId: cliMsgId ?? null,
            }),
        )
        .digest("hex")
        .slice(0, 24);
    return `client:${hash}`;
}

function parseFromMe(value) {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "outgoing", "from_me"].includes(normalized)) return true;
    if (["0", "false", "no", "incoming"].includes(normalized)) return false;
    throw new Error("--from-me must be true/false, 1/0, incoming, or outgoing");
}

function buildStatusBroadcastFixture({ msgId, senderId, senderName, text, msgType, timestamp, fromMe }) {
    const ts = timestamp === undefined ? Date.now() : Number(timestamp);
    if (!Number.isFinite(ts)) throw new Error("--timestamp must be a millisecond timestamp");

    return {
        msgId,
        threadId: "status@broadcast",
        senderId,
        senderName,
        ts,
        fromMe: fromMe ? 1 : 0,
        text,
        msgType,
        contentJson: JSON.stringify({
            qaFixture: true,
            source: "zalo-agent msg seed-status-broadcast",
            seededAt: new Date(ts).toISOString(),
        }),
    };
}

function previewMessageText(message) {
    if (message.recalled) return "[recalled/deleted]";
    return (message.text || "").slice(0, 200);
}

function formatLocalMessageLine(message) {
    const date = message.timestamp ? new Date(message.timestamp).toLocaleString() : "?";
    const threadName = message.threadName ? ` ${message.threadName}` : "";
    const sender = message.senderName || message.senderId || "?";
    const type = message.type || "unknown";
    const dir = message.fromMe ? "outgoing" : "incoming";
    const recalled = message.recalled ? " recalled/deleted" : "";
    return `[${date}] [${message.threadId}${threadName}] [${type}/${dir}${recalled}] ${sender}: ${previewMessageText(message)}`;
}

function localMessageFiltersFromOptions(opts) {
    if (opts.fromMe !== undefined && opts.fromThem) {
        throw new Error("Use only one of --from-me or --from-them.");
    }
    return {
        threadId: opts.chat || opts.thread,
        sender: opts.sender || opts.from,
        senderId: opts.senderId,
        senderName: opts.senderName,
        direction: opts.direction,
        fromMe: opts.fromThem ? false : parseFromMe(opts.fromMe),
        since: opts.since || opts.after,
        until: opts.until || opts.before,
        msgType: opts.type,
        media: opts.media,
        hasMedia: opts.hasMedia,
        limit: Number(opts.limit),
        order: opts.order,
    };
}

function addLocalMessageFilterOptions(command) {
    return command
        .option("-c, --chat <threadId>", "Filter by chat/thread ID")
        .option("--thread <threadId>", "Alias for --chat")
        .option("-s, --sender <sender>", "Filter by sender ID or sender display name")
        .option("--from <sender>", "Alias for --sender")
        .option("--sender-id <senderId>", "Filter by exact sender ID")
        .option("--sender-name <name>", "Filter by exact sender display name")
        .option("-d, --direction <direction>", "Filter by direction: incoming, outgoing, or from_me")
        .option("--from-me [value]", "Filter by from_me flag: true/false or 1/0")
        .option("--from-them", "Only show incoming messages")
        .option("--since <time>", "Filter messages at or after a millisecond timestamp or parseable date")
        .option("--after <time>", "Alias for --since")
        .option("--until <time>", "Filter messages at or before a millisecond timestamp or parseable date")
        .option("--before <time>", "Alias for --until")
        .option("--type <type>", "Filter by message/media type, for example text, image, file, voice")
        .option("--media", "Only include non-text media messages")
        .option("--has-media", "Only include messages with a downloaded local media path")
        .option("-n, --limit <n>", "Maximum results to return", "20");
}

function printJson(data) {
    console.log(JSON.stringify(data, null, 2));
}

export function persistOutgoingTextMessage({
    threadId,
    threadType,
    text,
    payload,
    result,
    ownId = getOwnId(),
    sentAt = Date.now(),
}) {
    const msgId =
        getSentMessageId(result) ||
        buildFallbackMessageId({
            ownId,
            threadId,
            threadType,
            text,
            cliMsgId: result?.cliMsgId,
        });

    upsertMessage({
        msgId,
        threadId,
        type: threadType,
        senderId: ownId || null,
        ts: sentAt,
        fromMe: 1,
        text,
        msgType: "text",
        contentJson: JSON.stringify({
            direction: "outgoing",
            payload,
            result,
        }),
    });

    return msgId;
}

export function registerMsgCommands(program) {
    const msg = program.command("msg").description("Send and manage messages");

    msg.command("send <threadId> <message>")
        .description("Send a text message with optional formatting")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option(
            "--mention <specs...>",
            "Mention users in group message. Format: pos:userId:len (e.g. 0:USER_ID:5). Use userId=-1 for @All.",
        )
        .option("--style <specs...>", "Text styles. Format: start:len:style (e.g. 0:5:bold 6:5:italic)")
        .option("--md", "Parse markdown-like formatting: **bold** *italic* __underline__ ~~strike~~ {red:text}")
        .option(
            "--react <icon>",
            "Auto-react to sent message. Codes: :> (haha), /-heart (heart), /-strong (like), :o (wow), :-(( (cry), :-h (angry)",
        )
        .action(async (threadId, message, opts) => {
            try {
                // Parse mention specs: "pos:uid:len" → { pos, uid, len }
                const mentions = (opts.mention || []).map((spec) => {
                    const [pos, uid, len] = spec.split(":");
                    return { pos: Number(pos), uid, len: Number(len) };
                });

                // Parse text styles
                let styles = [];
                let finalMsg = message;

                if (opts.md) {
                    // Markdown-like parsing: **bold** *italic* __underline__ ~~strike~~
                    const parsed = parseMarkdownStyles(message);
                    finalMsg = parsed.plain;
                    styles = parsed.styles;
                }

                if (opts.style) {
                    // Manual style specs: start:len:style
                    styles = styles.concat(parseStyleSpecs(opts.style));
                }

                // Build message content
                const hasExtras = mentions.length > 0 || styles.length > 0;
                const msgContent = hasExtras
                    ? { msg: finalMsg, ...(mentions.length > 0 && { mentions }), ...(styles.length > 0 && { styles }) }
                    : finalMsg;

                const cliMsgId = String(Date.now());
                const result = await getApi().sendMessage(msgContent, threadId, Number(opts.type));
                result.cliMsgId = cliMsgId;
                try {
                    persistOutgoingTextMessage({
                        threadId,
                        threadType: Number(opts.type),
                        text: finalMsg,
                        payload: msgContent,
                        result,
                    });
                } catch (dbError) {
                    warning(`Message sent, but local cache save failed: ${dbError.message}`);
                }
                output(result, program.opts().json, () => success("Message sent"));

                // Auto-react if --react flag provided
                if (opts.react && result.message?.msgId) {
                    const dest = {
                        data: { msgId: String(result.message.msgId), cliMsgId },
                        threadId,
                        type: Number(opts.type),
                    };
                    await getApi().addReaction(opts.react, dest);
                    success(`Auto-reacted with '${opts.react}'`);
                }
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-image <threadId> <paths...>")
        .description("Send one or more images")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .action(async (threadId, paths, opts) => {
            try {
                const absPaths = paths.map((p) => resolve(p));
                const result = await getApi().sendMessage(
                    { msg: opts.caption, attachments: absPaths },
                    threadId,
                    Number(opts.type),
                );
                output(result, program.opts().json, () => success(`Image(s) sent to ${threadId}`));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-file <threadId> <paths...>")
        .description("Send files (docx, pdf, zip, etc.)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .action(async (threadId, paths, opts) => {
            try {
                const absPaths = paths.map((p) => resolve(p));
                const result = await getApi().sendMessage(
                    { msg: opts.caption, attachments: absPaths },
                    threadId,
                    Number(opts.type),
                );
                output(result, program.opts().json, () => success(`File(s) sent to ${threadId}`));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-card <threadId> <userId>")
        .description("Send a contact card (danh thiếp)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--phone <num>", "Phone number (auto-fetched if omitted)")
        .action(async (threadId, userId, opts) => {
            try {
                const api = getApi();
                let phone = opts.phone;
                if (!phone) {
                    const userInfo = await api.getUserInfo(userId);
                    const profiles = userInfo?.changed_profiles || {};
                    phone = profiles[userId]?.phoneNumber || "";
                    if (phone) info(`Auto-detected phone: ${phone}`);
                }
                const cardOpts = { userId };
                if (phone) cardOpts.phoneNumber = phone;
                const result = await api.sendCard(cardOpts, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Card sent"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-bank <threadId> <accountNumber>")
        .description("Send a bank card (số tài khoản)")
        .requiredOption("-b, --bank <name>", "Bank name (ocb, vcb, bidv) or BIN code")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-n, --name <holder>", "Account holder name")
        .action(async (threadId, accountNumber, opts) => {
            try {
                const { resolveBankBin, BIN_TO_DISPLAY } = await import("../utils/bank-helpers.js");
                const bin = resolveBankBin(opts.bank);
                if (!bin) {
                    error(`Unknown bank: '${opts.bank}'`);
                    return;
                }
                info(`Bank: ${BIN_TO_DISPLAY[bin] || bin} (BIN ${bin})`);

                const payload = { binBank: bin, numAccBank: accountNumber };
                if (opts.name) payload.nameAccBank = opts.name;
                const result = await getApi().sendBankCard(payload, threadId, Number(opts.type));
                output(result, program.opts().json, () =>
                    success(`Bank card sent: ${BIN_TO_DISPLAY[bin]} / ${accountNumber}`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-qr-transfer <threadId> <accountNumber>")
        .description("Generate VietQR and send as image")
        .requiredOption("-b, --bank <name>", "Bank name or BIN code")
        .option("-a, --amount <n>", "Transfer amount in VND", (v) => parseInt(v, 10))
        .option("-m, --content <text>", "Transfer content (max 50 chars)")
        .option("--template <tpl>", "QR style: compact, print, qronly", "compact")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, accountNumber, opts) => {
            try {
                const { resolveBankBin, BIN_TO_DISPLAY, generateQrTransferImage } =
                    await import("../utils/bank-helpers.js");
                const bin = resolveBankBin(opts.bank);
                if (!bin) {
                    error(`Unknown bank: '${opts.bank}'`);
                    return;
                }
                if (opts.content && opts.content.length > 50) {
                    error(`Content too long (${opts.content.length} chars). VietQR max is 50.`);
                    return;
                }
                info(
                    `Generating QR: ${BIN_TO_DISPLAY[bin]} / ${accountNumber}${opts.amount ? ` / ${opts.amount.toLocaleString()}đ` : ""}`,
                );

                const qrPath = await generateQrTransferImage(
                    bin,
                    accountNumber,
                    opts.amount,
                    opts.content,
                    opts.template,
                );
                if (!qrPath) {
                    error("Failed to generate QR image");
                    return;
                }

                const caption = [
                    `QR chuyển khoản ${BIN_TO_DISPLAY[bin]} - ${accountNumber}`,
                    opts.amount ? `${opts.amount.toLocaleString()}đ` : null,
                    opts.content || null,
                ]
                    .filter(Boolean)
                    .join(" - ");

                const result = await getApi().sendMessage(
                    { msg: caption, attachments: [qrPath] },
                    threadId,
                    Number(opts.type),
                );

                // Cleanup temp file
                try {
                    (await import("fs")).unlinkSync(qrPath);
                } catch {}

                output(result, program.opts().json, () => success(`QR transfer sent to ${threadId}`));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("sticker <threadId> <keyword>")
        .description("Search and send a sticker")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, keyword, opts) => {
            try {
                const api = getApi();
                const search = await api.searchSticker(keyword);
                const first = search?.[0];
                if (!first) {
                    error("No sticker found");
                    return;
                }
                // sendSticker expects {id, cateId, type} object
                const stickerObj = {
                    id: first.sticker_id || first.stickerId || first.id,
                    cateId: first.cate_id || first.cateId,
                    type: first.type || 7,
                };
                const result = await api.sendSticker(stickerObj, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Sticker sent"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-voice <threadId> <voiceUrl>")
        .description("Send a voice message from URL")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--ttl <ms>", "Time to live in milliseconds", (v) => parseInt(v, 10), 0)
        .action(async (threadId, voiceUrl, opts) => {
            try {
                info(`Sending voice: ${voiceUrl}`);
                const result = await getApi().sendVoice({ voiceUrl, ttl: opts.ttl }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Voice sent to ${threadId}`));
            } catch (e) {
                error(`Send voice failed: ${e.message}`);
            }
        });

    msg.command("send-link <threadId> <url>")
        .description("Send a link with auto-preview (title, description, thumbnail)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text")
        .action(async (threadId, url, opts) => {
            try {
                info(`Sending link: ${url}`);
                const result = await getApi().sendLink({ link: url, msg: opts.caption }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Link sent to ${threadId}`));
            } catch (e) {
                error(`Send link failed: ${e.message}`);
            }
        });

    msg.command("send-video <threadId> <videoUrl>")
        .description("Send a video from URL")
        .requiredOption("--thumb <url>", "Thumbnail image URL")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .option("-d, --duration <ms>", "Video duration in milliseconds", (v) => parseInt(v, 10))
        .option("-W, --width <px>", "Video width", (v) => parseInt(v, 10), 1280)
        .option("-H, --height <px>", "Video height", (v) => parseInt(v, 10), 720)
        .action(async (threadId, videoUrl, opts) => {
            try {
                info(`Sending video: ${videoUrl}`);
                const result = await getApi().sendVideo(
                    {
                        videoUrl,
                        thumbnailUrl: opts.thumb,
                        msg: opts.caption,
                        duration: opts.duration,
                        width: opts.width,
                        height: opts.height,
                    },
                    threadId,
                    Number(opts.type),
                );
                output(result, program.opts().json, () => success(`Video sent to ${threadId}`));
            } catch (e) {
                error(`Send video failed: ${e.message}`);
            }
        });

    msg.command("sticker-list <keyword>")
        .description("Search stickers by keyword (returns sticker IDs)")
        .action(async (keyword) => {
            try {
                const result = await getApi().getStickers(keyword);
                output(result, program.opts().json, () => {
                    const ids = Array.isArray(result) ? result : [];
                    info(`${ids.length} sticker(s) found for "${keyword}"`);
                    for (const id of ids) console.log(`  ${id}`);
                });
            } catch (e) {
                error(`Sticker search failed: ${e.message}`);
            }
        });

    msg.command("sticker-detail <stickerIds...>")
        .description("Get sticker details by IDs")
        .action(async (stickerIds) => {
            try {
                const ids = stickerIds.map(Number);
                const result = await getApi().getStickersDetail(ids);
                output(result, program.opts().json);
            } catch (e) {
                error(`Sticker detail failed: ${e.message}`);
            }
        });

    msg.command("sticker-category <categoryId>")
        .description("Get sticker category details")
        .action(async (categoryId) => {
            try {
                const result = await getApi().getStickerCategoryDetail(Number(categoryId));
                output(result, program.opts().json);
            } catch (e) {
                error(`Sticker category failed: ${e.message}`);
            }
        });

    msg.command("react <msgId> <threadId> <reaction>")
        .description(
            "React to a message. Reaction codes: :> (haha), /-heart (heart), /-strong (like), :o (wow), :-(( (cry), :-h (angry)",
        )
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-c, --cli-msg-id <id>", "Client message ID (required for reaction to appear, get from listen --json)")
        .action(async (msgId, threadId, reaction, opts) => {
            try {
                // zca-js addReaction(icon, dest) — dest needs msgId + cliMsgId
                const dest = {
                    data: { msgId, cliMsgId: opts.cliMsgId || msgId },
                    threadId,
                    type: Number(opts.type),
                };
                const result = await getApi().addReaction(reaction, dest);
                output(result, program.opts().json, () => success(`Reacted with '${reaction}'`));
            } catch (e) {
                error(`React failed: ${e.message}`);
            }
        });

    msg.command("delete <msgId> <threadId>")
        .description("Delete a message you sent")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (msgId, threadId, opts) => {
            try {
                const result = await getApi().deleteMessage(msgId, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message deleted"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("undo <msgId> <threadId>")
        .description("Recall/undo a message for both sides (like Zalo app recall). Requires cliMsgId.")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-c, --cli-msg-id <id>", "Client message ID (required, get from listen --json or send --json)")
        .action(async (msgId, threadId, opts) => {
            try {
                if (!opts.cliMsgId) {
                    error("cliMsgId is required for undo. Get it from: listen --json or send --json output.");
                    return;
                }
                const payload = { msgId, cliMsgId: opts.cliMsgId };
                const result = await getApi().undo(payload, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message recalled (undone)"));
            } catch (e) {
                error(`Undo failed: ${e.message}`);
            }
        });

    msg.command("forward <msgId> <threadId>")
        .description("Forward a message to another thread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (msgId, threadId, opts) => {
            try {
                const result = await getApi().forwardMessage(msgId, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message forwarded"));
            } catch (e) {
                error(e.message);
            }
        });

    addLocalMessageFilterOptions(msg.command("list").description("List cached local messages without remote fetches"))
        .option("--order <order>", "Sort order: desc or asc", "desc")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const filters = localMessageFiltersFromOptions(opts);
                const messages = listLocalMessages(filters);
                output(
                    {
                        source: "local",
                        count: messages.length,
                        filters,
                        messages,
                    },
                    jsonMode,
                    () => {
                        success(`${messages.length} cached message(s) found`);
                        for (const message of messages) console.log(`  ${formatLocalMessageLine(message)}`);
                    },
                );
                process.exit(0);
            } catch (e) {
                error(`Local message list failed: ${e.message}`);
                process.exit(1);
            }
        });

    addLocalMessageFilterOptions(msg.command("export").description("Export cached local messages as JSON"))
        .option("--order <order>", "Sort order: desc or asc", "desc")
        .option("--asc", "Sort exported messages from oldest to newest")
        .option("--status", "Export status broadcasts instead of regular chat messages")
        .option("--raw", "Include parsed and raw content_json for each exported message")
        .option("-o, --output <path>", "Write JSON export to a file")
        .action(async (opts) => {
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const filters = {
                    ...localMessageFiltersFromOptions({
                        ...opts,
                        order: opts.asc ? "asc" : opts.order,
                    }),
                    status: opts.status,
                    includeRaw: opts.raw,
                };
                const envelope = exportLocalMessages({
                    ...filters,
                    accountId: getActive()?.ownId || getOwnId() || null,
                });
                if (opts.output) {
                    fs.writeFileSync(resolve(opts.output), `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
                    if (program.opts().json) printJson(envelope);
                } else {
                    printJson(envelope);
                }
                process.exit(0);
            } catch (e) {
                error(`Local message export failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("show")
        .description("Show one cached local message by message ID")
        .requiredOption("--id <msgId>", "Cached message ID")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const message = getLocalMessageById(opts.id);
                if (!message) {
                    output({ source: "local", found: false, msgId: opts.id, message: null }, jsonMode, () =>
                        error(`Message with ID '${opts.id}' not found in local cache.`),
                    );
                    process.exit(1);
                }
                output(
                    {
                        source: "local",
                        found: true,
                        msgId: opts.id,
                        message,
                    },
                    jsonMode,
                    () => {
                        success(`Cached message ${message.msgId}`);
                        console.log(`  ${formatLocalMessageLine(message)}`);
                        if (message.localPath) console.log(`  localPath: ${message.localPath}`);
                    },
                );
                process.exit(0);
            } catch (e) {
                error(`Local message show failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("context")
        .description("Show cached local messages around a message ID")
        .requiredOption("--id <msgId>", "Cached message ID")
        .option("--before <n>", "Number of same-thread messages before the target", "3")
        .option("--after <n>", "Number of same-thread messages after the target", "3")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const context = getLocalMessageContext(opts.id, {
                    before: Number(opts.before),
                    after: Number(opts.after),
                });
                if (!context.target) {
                    output(
                        { source: "local", found: false, msgId: opts.id, before: [], target: null, after: [] },
                        jsonMode,
                        () => error(`Message with ID '${opts.id}' not found in local cache.`),
                    );
                    process.exit(1);
                }
                output(
                    {
                        source: "local",
                        found: true,
                        msgId: opts.id,
                        threadId: context.target.threadId,
                        before: context.before,
                        target: context.target,
                        after: context.after,
                        count: context.before.length + 1 + context.after.length,
                    },
                    jsonMode,
                    () => {
                        success(
                            `${context.before.length} before, target, ${context.after.length} after in ${context.target.threadId}`,
                        );
                        for (const message of context.before) console.log(`  ${formatLocalMessageLine(message)}`);
                        console.log(`> ${formatLocalMessageLine(context.target)}`);
                        for (const message of context.after) console.log(`  ${formatLocalMessageLine(message)}`);
                    },
                );
                process.exit(0);
            } catch (e) {
                error(`Local message context failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("search [query]")
        .description("Search cached local messages offline")
        .option("-c, --chat <threadId>", "Filter by chat/thread ID")
        .option("--thread <threadId>", "Alias for --chat")
        .option("-s, --sender <sender>", "Filter by sender ID or sender display name")
        .option("--from <sender>", "Alias for --sender")
        .option("--sender-id <senderId>", "Filter by exact sender ID")
        .option("--sender-name <name>", "Filter by exact sender display name")
        .option("-d, --direction <direction>", "Filter by direction: incoming, outgoing, or from_me")
        .option("--from-me [value]", "Filter by from_me flag: true/false or 1/0")
        .option("--from-them", "Only show incoming messages")
        .option("--since <time>", "Filter messages at or after a millisecond timestamp or parseable date")
        .option("--after <time>", "Alias for --since")
        .option("--until <time>", "Filter messages at or before a millisecond timestamp or parseable date")
        .option("--before <time>", "Alias for --until")
        .option("--type <type>", "Filter by message/media type, for example text, image, file, voice")
        .option("--media", "Only include non-text media messages")
        .option("--has-media", "Only include messages with a downloaded local media path")
        .option("--status", "Search status broadcasts instead of regular chat messages")
        .option("-n, --limit <n>", "Maximum results to return", "20")
        .action(async (query = "", opts) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }

                if (opts.fromMe !== undefined && opts.fromThem) {
                    throw new Error("Use only one of --from-me or --from-them.");
                }

                const fromMe = opts.fromThem ? false : parseFromMe(opts.fromMe);
                const filters = {
                    query,
                    threadId: opts.chat || opts.thread,
                    sender: opts.sender || opts.from,
                    senderId: opts.senderId,
                    senderName: opts.senderName,
                    direction: opts.direction,
                    fromMe,
                    since: opts.since || opts.after,
                    until: opts.until || opts.before,
                    msgType: opts.type,
                    media: opts.media,
                    hasMedia: opts.hasMedia,
                    limit: Number(opts.limit),
                };

                if (opts.status) {
                    const statuses = getLocalStatusBroadcasts(filters);
                    output(
                        {
                            query,
                            mode: "like",
                            source: "like",
                            status: true,
                            count: statuses.length,
                            messages: statuses,
                        },
                        jsonMode,
                        () => {
                            success(`${statuses.length} status broadcast(s) found`);
                            for (const m of statuses) {
                                const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                                const name = m.senderName || m.senderId || "?";
                                console.log(`  [${date}] ${name}: ${(m.text || "").slice(0, 200)}`);
                            }
                        },
                    );
                    process.exit(0);
                }

                const result = searchLocalMessages(filters);
                output(
                    {
                        query,
                        mode: result.mode,
                        source: result.mode === "fts5" ? "fts" : result.mode,
                        fallback: result.fallback,
                        ftsError: result.ftsError,
                        count: result.messages.length,
                        messages: result.messages,
                    },
                    jsonMode,
                    () => {
                        const suffix = result.fallback ? " (LIKE fallback)" : "";
                        success(`${result.messages.length} message(s) found via ${result.mode}${suffix}`);
                        for (const m of result.messages) {
                            const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                            const name = m.senderName || m.senderId || "?";
                            const dir = m.fromMe ? "→" : "←";
                            console.log(`  ${dir} [${date}] [${m.threadId}] ${name}: ${(m.text || "").slice(0, 200)}`);
                        }
                    },
                );
                process.exit(0);
            } catch (e) {
                error(`Search failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("seed-status-broadcast")
        .description("Seed a local status broadcast fixture for installed CLI QA")
        .option("--id <msgId>", "Fixture message id", "qa-status-broadcast-fixture")
        .option("--sender-id <senderId>", "Fixture sender id", "qa-status-sender")
        .option("--sender-name <name>", "Fixture sender display name", "QA Status Fixture")
        .option("--text <text>", "Fixture text", "qa-status-broadcast-positive-fixture")
        .option("--type <type>", "Fixture message/media type", "image")
        .option("--timestamp <ms>", "Fixture timestamp in milliseconds")
        .option("--from-me", "Mark fixture as outgoing/from_me")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }

                const fixture = buildStatusBroadcastFixture({
                    msgId: opts.id,
                    senderId: opts.senderId,
                    senderName: opts.senderName,
                    text: opts.text,
                    msgType: opts.type,
                    timestamp: opts.timestamp,
                    fromMe: opts.fromMe,
                });
                upsertStatusBroadcast(fixture);

                const matches = getLocalStatusBroadcasts({ query: fixture.text, limit: 1 });
                output(
                    {
                        status: true,
                        seeded: true,
                        msgId: fixture.msgId,
                        threadId: fixture.threadId,
                        senderId: fixture.senderId,
                        senderName: fixture.senderName,
                        text: fixture.text,
                        timestamp: fixture.ts,
                        type: fixture.msgType,
                        searchCommand: `zalo-agent --json msg search ${JSON.stringify(fixture.text)} --status --limit 3`,
                        count: matches.length,
                        messages: matches,
                    },
                    jsonMode,
                    () => {
                        success(`Seeded status broadcast fixture ${fixture.msgId}`);
                        info(
                            `Validate with: zalo-agent --json msg search ${JSON.stringify(fixture.text)} --status --limit 3`,
                        );
                    },
                );
                process.exit(0);
            } catch (e) {
                error(`Seed status broadcast failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("history <threadId>")
        .description("Fetch message history from a DM or group conversation via WebSocket")
        .option("-t, --type <n>", "Thread type: 0=User(DM), 1=Group", "0")
        .option("-n, --limit <n>", "Max messages to fetch (fetches in pages until limit)", "50")
        .option("--timeout <ms>", "Timeout in milliseconds waiting for response", "15000")
        .action(async (threadId, opts) => {
            const jsonMode = program.opts().json;
            const threadType = Number(opts.type);
            const limit = Number(opts.limit);
            const timeout = Number(opts.timeout);

            try {
                if (!jsonMode && limit > 100) {
                    info(
                        `Warning: fetching up to ${limit} messages. Large history may use significant memory and bandwidth.`,
                    );
                }

                const db = getDb();
                let allMessages = [];

                if (db) {
                    const localCount = getLocalMessagesCount(threadId);
                    if (localCount >= limit) {
                        allMessages = getLocalMessages(threadId, limit);
                        allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

                        output(
                            {
                                threadId,
                                threadType: threadType === 0 ? "dm" : "group",
                                count: allMessages.length,
                                messages: allMessages,
                            },
                            jsonMode,
                            () => {
                                success(`${allMessages.length} message(s) from ${threadId} (loaded from local cache)`);
                                for (const m of allMessages) {
                                    const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                                    const name = m.senderName || m.senderId || "?";
                                    console.log(`  [${date}] ${name}: ${(m.text || "").slice(0, 200)}`);
                                }
                            },
                        );
                        process.exit(0);
                    }
                }

                const api = getApi();
                let lastMsgId = null;

                if (db) {
                    lastMsgId = getOldestMessageId(threadId);
                }

                let done = false;
                const fetchedMessages = [];

                // Start listener (required for WebSocket requestOldMessages)
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("Listener connection timeout")), 10000);
                    api.listener.on("connected", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                    api.listener.on("error", (err) => {
                        clearTimeout(timer);
                        reject(err);
                    });
                    api.listener.start({ retryOnClose: false });
                });

                const localCount = db ? getLocalMessagesCount(threadId) : 0;
                const needed = limit - localCount;

                // Fetch pages until limit reached or no more messages
                while (!done && fetchedMessages.length < needed) {
                    const pageMessages = await new Promise((resolve) => {
                        const handler = (messages) => {
                            clearTimeout(timer);
                            api.listener.removeListener("old_messages", handler);
                            resolve(messages);
                        };
                        const timer = setTimeout(() => {
                            api.listener.removeListener("old_messages", handler);
                            resolve([]);
                        }, timeout);

                        api.listener.on("old_messages", handler);
                        api.listener.requestOldMessages(threadType, lastMsgId);
                    });

                    if (!pageMessages || pageMessages.length === 0) {
                        done = true;
                        break;
                    }

                    for (const msg of pageMessages) {
                        // API returns messages globally — filter to requested thread
                        const msgThread = String(msg.threadId || "");
                        const msgSender = String(msg.data?.uidFrom || "");
                        const target = String(threadId);
                        if (msgThread !== target && msgSender !== target) continue;

                        const parsedMsg = {
                            msgId: msg.data?.msgId,
                            threadId: msg.threadId,
                            senderId: msg.data?.uidFrom || null,
                            senderName: msg.data?.dName || null,
                            text:
                                typeof msg.data?.content === "string"
                                    ? msg.data.content
                                    : extractMessageText(msg.data?.content, msg.data?.msgType),
                            timestamp: msg.data?.ts ? Number(msg.data.ts) : null,
                            type: typeof msg.data?.content === "string" ? "text" : msg.data?.msgType || "attachment",
                        };

                        fetchedMessages.push(parsedMsg);

                        if (db) {
                            upsertMessage({
                                msgId: msg.data?.msgId,
                                threadId: msg.threadId,
                                senderId: msg.data?.uidFrom || null,
                                senderName: msg.data?.dName || null,
                                ts: msg.data?.ts ? Number(msg.data.ts) : Date.now(),
                                fromMe: msg.isSelf ? 1 : 0,
                                text: parsedMsg.text,
                                msgType: parsedMsg.type,
                                contentJson: JSON.stringify(msg.data),
                                recalled: msg.data?.recalled ?? 0,
                            });
                        }
                    }

                    // Use last message's actionId for pagination
                    const lastMsg = pageMessages[pageMessages.length - 1];
                    const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                    if (!nextId || nextId === lastMsgId) {
                        done = true;
                    }
                    lastMsgId = nextId;
                }

                if (db) {
                    allMessages = getLocalMessages(threadId, limit);
                } else {
                    allMessages = fetchedMessages.slice(0, limit);
                }

                // Sort by timestamp (oldest first)
                allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

                output(
                    {
                        threadId,
                        threadType: threadType === 0 ? "dm" : "group",
                        count: allMessages.length,
                        messages: allMessages,
                    },
                    jsonMode,
                    () => {
                        success(`${allMessages.length} message(s) from ${threadId}`);
                        for (const m of allMessages) {
                            const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                            const name = m.senderName || m.senderId || "?";
                            console.log(`  [${date}] ${name}: ${(m.text || "").slice(0, 200)}`);
                        }
                    },
                );

                // Clean up listener
                api.listener.stop();
                process.exit(0);
            } catch (e) {
                try {
                    api.listener.stop();
                } catch {}
                error(`History fetch failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("download <msgId>")
        .description("Download an attachment/media for a specific message by ID")
        .action(async (msgId) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const messageRow = db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(msgId);
                if (!messageRow) {
                    error(`Message with ID '${msgId}' not found in local cache.`);
                    process.exit(1);
                }
                if (messageRow.local_path) {
                    info(`Attachment already downloaded locally: ${messageRow.local_path}`);
                    output({ localPath: messageRow.local_path }, jsonMode);
                    process.exit(0);
                }
                let content = null;
                try {
                    content = JSON.parse(messageRow.content_json);
                } catch {}
                if (!content) {
                    error("Message raw content could not be parsed.");
                    process.exit(1);
                }
                // extract URL/filename/subfolder
                const mediaInfo = getMediaInfo(content.content || content, messageRow.msg_type);
                if (!mediaInfo) {
                    error(`Message '${msgId}' is not a media message or does not contain a download URL.`);
                    process.exit(1);
                }
                const ownId = getOwnId();
                if (!ownId) {
                    error("Could not determine current logged-in user ID.");
                    process.exit(1);
                }
                if (!jsonMode) info(`Downloading ${mediaInfo.filename} (${msgId})...`);
                const localPath = await downloadAttachment(
                    ownId,
                    msgId,
                    mediaInfo.subfolder,
                    mediaInfo.url,
                    mediaInfo.filename,
                );
                updateMessageLocalPath(msgId, localPath);
                success(`Downloaded attachment to ${localPath}`);
                output({ localPath }, jsonMode);
                process.exit(0);
            } catch (e) {
                error(`Download failed: ${e.message}`);
                process.exit(1);
            }
        });

    msg.command("media-sync <threadId>")
        .description("Sync (download) all media attachments for a conversation")
        .action(async (threadId) => {
            const jsonMode = program.opts().json;
            try {
                const db = getDb();
                if (!db) {
                    error("Database is not initialized. Make sure you are logged in.");
                    process.exit(1);
                }
                const ownId = getOwnId();
                if (!ownId) {
                    error("Could not determine current logged-in user ID.");
                    process.exit(1);
                }
                const rows = db
                    .prepare(
                        `
                    SELECT msg_id, msg_type, content_json 
                    FROM messages 
                    WHERE thread_id = ? AND local_path IS NULL AND recalled = 0 AND msg_type != 'text'
                `,
                    )
                    .all(threadId);

                if (!rows || rows.length === 0) {
                    info(`No undownloaded media attachments found in local cache for thread '${threadId}'.`);
                    output({ successCount: 0, failCount: 0 }, jsonMode);
                    process.exit(0);
                }

                if (!jsonMode) info(`Found ${rows.length} undownloaded media message(s). Starting sync...`);

                let successCount = 0;
                let failCount = 0;
                const downloadedPaths = [];

                for (const row of rows) {
                    let content = null;
                    try {
                        content = JSON.parse(row.content_json);
                    } catch {}
                    if (!content) continue;
                    const mediaInfo = getMediaInfo(content.content || content, row.msg_type);
                    if (!mediaInfo) continue;
                    try {
                        if (!jsonMode) info(`Downloading ${mediaInfo.filename} (${row.msg_id})...`);
                        const localPath = await downloadAttachment(
                            ownId,
                            row.msg_id,
                            mediaInfo.subfolder,
                            mediaInfo.url,
                            mediaInfo.filename,
                        );
                        updateMessageLocalPath(row.msg_id, localPath);
                        downloadedPaths.push(localPath);
                        successCount++;
                    } catch (err) {
                        failCount++;
                        if (!jsonMode) warning(`Failed to download ${row.msg_id}: ${err.message}`);
                    }
                }

                success(`Sync complete. Successfully downloaded ${successCount} files. Fails: ${failCount}`);
                output({ successCount, failCount, files: downloadedPaths }, jsonMode);
                process.exit(0);
            } catch (e) {
                error(`Media sync failed: ${e.message}`);
                process.exit(1);
            }
        });
}
