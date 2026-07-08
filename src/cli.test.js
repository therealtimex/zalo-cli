/**
 * CLI interface tests — verify command parsing, help output, and basic behavior
 * without requiring a Zalo session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "path";

const CLI = resolve(import.meta.dirname, "index.js");

function runWithEnv(args, env = {}) {
    return execFileSync("node", [CLI, ...args], {
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, HOME: "/tmp/zalo-agent-cli-test-home", ...env },
    });
}

function run(...args) {
    return runWithEnv(args);
}

describe("CLI interface", () => {
    it("--version outputs 1.0.0", () => {
        const out = run("--version");
        assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
    });

    it("--help lists all command groups", () => {
        const out = run("--help");
        assert.match(out, /login/);
        assert.match(out, /msg/);
        assert.match(out, /friend/);
        assert.match(out, /group/);
        assert.match(out, /conv/);
        assert.match(out, /account/);
        assert.match(out, /doctor/);
        assert.match(out, /store/);
    });

    it("msg --help lists all subcommands", () => {
        const out = run("msg", "--help");
        assert.match(out, /send /);
        assert.match(out, /send-image/);
        assert.match(out, /send-file/);
        assert.match(out, /send-card/);
        assert.match(out, /send-bank/);
        assert.match(out, /send-qr-transfer/);
        assert.match(out, /sticker/);
        assert.match(out, /react/);
        assert.match(out, /delete/);
        assert.match(out, /forward/);
        assert.match(out, /search/);
        assert.match(out, /list/);
        assert.match(out, /export/);
        assert.match(out, /show/);
        assert.match(out, /context/);
        assert.match(out, /seed-status-broadcast/);
        assert.match(out, /download/);
        assert.match(out, /media-sync/);
    });

    it("msg search --help lists offline search filters", () => {
        const out = run("msg", "search", "--help");
        assert.match(out, /--chat/);
        assert.match(out, /--thread/);
        assert.match(out, /--sender/);
        assert.match(out, /--from/);
        assert.match(out, /--direction/);
        assert.match(out, /--from-them/);
        assert.match(out, /--since/);
        assert.match(out, /--after/);
        assert.match(out, /--until/);
        assert.match(out, /--before/);
        assert.match(out, /--type/);
        assert.match(out, /--has-media/);
        assert.match(out, /--status/);
    });

    it("msg list --help lists local inspection filters", () => {
        const out = run("msg", "list", "--help");
        assert.match(out, /--chat/);
        assert.match(out, /--thread/);
        assert.match(out, /--sender/);
        assert.match(out, /--from/);
        assert.match(out, /--direction/);
        assert.match(out, /--from-me/);
        assert.match(out, /--from-them/);
        assert.match(out, /--since/);
        assert.match(out, /--after/);
        assert.match(out, /--until/);
        assert.match(out, /--before/);
        assert.match(out, /--type/);
        assert.match(out, /--media/);
        assert.match(out, /--has-media/);
        assert.match(out, /--order/);
    });

    it("msg export --help lists local JSON export options", () => {
        const out = run("msg", "export", "--help");
        assert.match(out, /--chat/);
        assert.match(out, /--thread/);
        assert.match(out, /--after/);
        assert.match(out, /--before/);
        assert.match(out, /--limit/);
        assert.match(out, /--order/);
        assert.match(out, /--asc/);
        assert.match(out, /--status/);
        assert.match(out, /--raw/);
        assert.match(out, /--output/);
    });

    it("msg show and context --help list local inspection options", () => {
        const show = run("msg", "show", "--help");
        assert.match(show, /--id/);

        const context = run("msg", "context", "--help");
        assert.match(context, /--id/);
        assert.match(context, /--before/);
        assert.match(context, /--after/);
    });

    it("msg seed-status-broadcast --help lists QA fixture options", () => {
        const out = run("msg", "seed-status-broadcast", "--help");
        assert.match(out, /--id/);
        assert.match(out, /--sender-id/);
        assert.match(out, /--text/);
        assert.match(out, /--timestamp/);
    });

    it("listen --help lists option --download-media", () => {
        const out = run("listen", "--help");
        assert.match(out, /--download-media/);
    });

    it("friend --help lists subcommands", () => {
        const out = run("friend", "--help");
        assert.match(out, /list/);
        assert.match(out, /find/);
        assert.match(out, /info/);
        assert.match(out, /block/);
    });

    it("group --help lists subcommands", () => {
        const out = run("group", "--help");
        assert.match(out, /create/);
        assert.match(out, /members/);
        assert.match(out, /rename/);
    });

    it("conv --help lists subcommands", () => {
        const out = run("conv", "--help");
        assert.match(out, /mute/);
        assert.match(out, /pinned/);
        assert.match(out, /archived/);
    });

    it("account --help lists subcommands", () => {
        const out = run("account", "--help");
        assert.match(out, /login/);
        assert.match(out, /switch/);
        assert.match(out, /export/);
        assert.match(out, /remove/);
    });

    it("login --help shows all flags", () => {
        const out = run("login", "--help");
        assert.match(out, /--proxy/);
        assert.match(out, /--credentials/);
        assert.match(out, /--qr-url/);
        assert.match(out, /--qr-port/);
    });

    it("logout --help shows --purge", () => {
        const out = run("logout", "--help");
        assert.match(out, /--purge/);
    });

    it("account list on clean state shows no accounts", () => {
        const out = run("account", "list");
        assert.match(out, /No accounts/);
    });

    it("sync --help lists all sync flags", () => {
        const out = run("sync", "--help");
        assert.match(out, /--per-thread/);
        assert.match(out, /--delay/);
        assert.match(out, /--timeout/);
        assert.match(out, /--download-media/);
    });

    it("doctor --help lists doctor flags", () => {
        const out = run("doctor", "--help");
        assert.match(out, /--connect/);
        assert.match(out, /--json/);
    });

    it("doctor --json on clean state is parseable and does not require auth", () => {
        const out = run("doctor", "--json");
        const data = JSON.parse(out);
        assert.equal(data.auth.active, false);
        assert.equal(data.store.exists, false);
        assert.equal(data.connect.attempted, false);
    });

    it("store --help lists local stats and cleanup commands", () => {
        const out = run("store", "--help");
        assert.match(out, /stats/);
        assert.match(out, /cleanup/);
    });

    it("store stats and cleanup operate on the local cache only", () => {
        const configDir = join(tmpdir(), `zalo-agent-cli-store-${process.pid}-${Date.now()}`);
        const ownId = "cli_store_user";
        const now = Date.UTC(2026, 0, 10);
        try {
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                join(configDir, "accounts.json"),
                JSON.stringify([{ ownId, name: "CLI Store", proxy: null, active: true }]),
                "utf-8",
            );
            const mediaPath = join(configDir, "media.bin");
            fs.writeFileSync(mediaPath, "12345");

            execFileSync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    `
                        process.env.ZALO_CONFIG_DIR = ${JSON.stringify(configDir)};
                        const { initDatabase, upsertContact, upsertGroup, upsertGroupParticipant, upsertMessage, closeDatabase } = await import(${JSON.stringify(resolve(import.meta.dirname, "core/db.js"))});
                        await initDatabase(${JSON.stringify(ownId)});
                        upsertContact({ userId: "store-member", displayName: "Store Member" });
                        upsertGroup({ groupId: "thread_store", name: "Store Thread", memberCount: 1 });
                        upsertGroupParticipant("thread_store", "store-member", {});
                        upsertMessage({ msgId: "cli-store-old", threadId: "thread_store", senderId: "store-member", senderName: "Store Member", ts: ${now - 4 * 86400000}, text: "old local cache row", msgType: "image", localPath: ${JSON.stringify(mediaPath)} });
                        upsertMessage({ msgId: "cli-store-new", threadId: "thread_store", senderId: "store-member", senderName: "Store Member", ts: ${now}, text: "new local cache row", msgType: "text" });
                        upsertMessage({ msgId: "cli-store-status", threadId: "status@broadcast", senderId: "store-member", senderName: "Store Member", ts: ${now - 4 * 86400000}, text: "old status local cache row", msgType: "text" });
                        closeDatabase();
                    `,
                ],
                { encoding: "utf-8", timeout: 10000, env: { ...process.env, ZALO_CONFIG_DIR: configDir } },
            );

            const statsOut = runWithEnv(["--json", "store", "stats"], { ZALO_CONFIG_DIR: configDir });
            const stats = JSON.parse(statsOut);
            assert.equal(stats.local_only, true);
            assert.equal(stats.counts.messages, 2);
            assert.equal(stats.counts.status_broadcasts, 1);
            assert.equal(stats.downloaded_media.files, 1);
            assert.equal(stats.downloaded_media.bytes, 5);

            const humanStats = runWithEnv(["store", "stats"], { ZALO_CONFIG_DIR: configDir });
            assert.match(humanStats, /Local cache only/);

            const dryRunOut = runWithEnv(["--json", "store", "cleanup", "--days", "1", "--dry-run"], {
                ZALO_CONFIG_DIR: configDir,
                ZALO_AGENT_TEST_NOW: String(now),
            });
            const dryRun = JSON.parse(dryRunOut);
            assert.equal(dryRun.dry_run, true);
            assert.equal(dryRun.planned.messages, 1);
            assert.equal(dryRun.planned.status_broadcasts, 1);
            assert.equal(dryRun.deleted.messages, 0);

            try {
                runWithEnv(["--json", "store", "cleanup", "--days", "1"], { ZALO_CONFIG_DIR: configDir });
                assert.fail("store cleanup should require confirmation");
            } catch (e) {
                assert.match(e.stdout || e.message, /requires --confirm/);
            }

            const confirmOut = runWithEnv(["--json", "store", "cleanup", "--days", "1", "--confirm"], {
                ZALO_CONFIG_DIR: configDir,
                ZALO_AGENT_TEST_NOW: String(now),
            });
            const confirmed = JSON.parse(confirmOut);
            assert.equal(confirmed.deleted.messages, 1);
            assert.equal(confirmed.deleted.status_broadcasts, 1);

            const after = JSON.parse(runWithEnv(["--json", "store", "stats"], { ZALO_CONFIG_DIR: configDir }));
            assert.equal(after.counts.messages, 1);
            assert.equal(after.counts.status_broadcasts, 0);

            try {
                runWithEnv(["--read-only", "--json", "store", "cleanup", "--thread", "thread_store", "--confirm"], {
                    ZALO_CONFIG_DIR: configDir,
                });
                assert.fail("store cleanup should be blocked by --read-only");
            } catch (e) {
                assert.match(e.stdout || e.message, /blocked by --read-only/);
            }

            const threadDryRun = JSON.parse(
                runWithEnv(["--json", "store", "cleanup", "--thread", "thread_store", "--dry-run"], {
                    ZALO_CONFIG_DIR: configDir,
                }),
            );
            assert.equal(threadDryRun.planned.chats, 1);
            assert.equal(threadDryRun.planned.groups, 1);
            assert.equal(threadDryRun.planned.group_participants, 1);
            assert.equal(threadDryRun.planned.messages, 1);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("executes msg search against an initialized local cache without saved credentials", () => {
        const configDir = join(tmpdir(), `zalo-agent-cli-search-${process.pid}-${Date.now()}`);
        const ownId = "cli_search_user";
        try {
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                join(configDir, "accounts.json"),
                JSON.stringify([{ ownId, name: "CLI Search", proxy: null, active: true }]),
                "utf-8",
            );

            execFileSync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    `
                        process.env.ZALO_CONFIG_DIR = ${JSON.stringify(configDir)};
                        const { initDatabase, upsertMessage, closeDatabase } = await import(${JSON.stringify(resolve(import.meta.dirname, "core/db.js"))});
                        await initDatabase(${JSON.stringify(ownId)});
                        upsertMessage({
                            msgId: "cli-search-1",
                            threadId: "thread_cli",
                            senderId: "friend_cli",
                            senderName: "CLI Friend",
                            ts: 1234567890000,
                            fromMe: 0,
                            text: "offline CLI search result",
                            msgType: "text"
                        });
                        closeDatabase();
                    `,
                ],
                { encoding: "utf-8", timeout: 10000, env: { ...process.env, ZALO_CONFIG_DIR: configDir } },
            );

            const out = runWithEnv(["--json", "msg", "search", "offline", "--thread", "thread_cli"], {
                ZALO_CONFIG_DIR: configDir,
            });
            const parsed = JSON.parse(out);

            assert.equal(parsed.query, "offline");
            assert.equal(parsed.count, 1);
            assert.equal(parsed.source, "fts");
            assert.equal(parsed.messages[0].msgId, "cli-search-1");
            assert.equal(parsed.messages[0].threadId, "thread_cli");
            assert.equal(parsed.messages[0].text, "offline CLI search result");
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("executes msg list, show, and context against an initialized local cache without saved credentials", () => {
        const configDir = join(tmpdir(), `zalo-agent-cli-local-msg-${process.pid}-${Date.now()}`);
        const ownId = "cli_local_user";
        try {
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                join(configDir, "accounts.json"),
                JSON.stringify([{ ownId, name: "CLI Local", proxy: null, active: true }]),
                "utf-8",
            );

            execFileSync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    `
                        process.env.ZALO_CONFIG_DIR = ${JSON.stringify(configDir)};
                        const { initDatabase, upsertChat, upsertMessage, closeDatabase } = await import(${JSON.stringify(resolve(import.meta.dirname, "core/db.js"))});
                        await initDatabase(${JSON.stringify(ownId)});
                        upsertChat({ threadId: "thread_cli_local", type: 1, name: "CLI Local Thread", lastMessageTs: 4000 });
                        for (const message of [
                            { msgId: "cli-local-1", threadId: "thread_cli_local", senderId: "friend_cli", senderName: "CLI Friend", ts: 1000, fromMe: 0, text: "before target", msgType: "text" },
                            { msgId: "cli-local-2", threadId: "thread_cli_local", senderId: ${JSON.stringify(ownId)}, senderName: "Me", ts: 2000, fromMe: 1, text: "target image", msgType: "image", localPath: "/tmp/cli-local.png", contentJson: JSON.stringify({ actionId: "action-cli-local-2", media: true }) },
                            { msgId: "cli-local-3", threadId: "thread_cli_local", senderId: "friend_cli", senderName: "CLI Friend", ts: 3000, fromMe: 0, text: null, msgType: "text", recalled: 1 },
                            { msgId: "cli-local-other", threadId: "other_thread", senderId: "friend_cli", senderName: "CLI Friend", ts: 2500, fromMe: 0, text: "other thread", msgType: "text" }
                        ]) upsertMessage(message);
                        closeDatabase();
                    `,
                ],
                { encoding: "utf-8", timeout: 10000, env: { ...process.env, ZALO_CONFIG_DIR: configDir } },
            );

            const listOut = runWithEnv(
                [
                    "--json",
                    "msg",
                    "list",
                    "--thread",
                    "thread_cli_local",
                    "--from-me",
                    "--type",
                    "image",
                    "--has-media",
                    "--order",
                    "asc",
                ],
                { ZALO_CONFIG_DIR: configDir },
            );
            const list = JSON.parse(listOut);
            assert.equal(list.source, "local");
            assert.equal(list.count, 1);
            assert.equal(list.messages[0].msgId, "cli-local-2");
            assert.equal(list.messages[0].threadName, "CLI Local Thread");
            assert.equal(list.messages[0].direction, "outgoing");
            assert.equal(list.messages[0].localPath, "/tmp/cli-local.png");

            const showOut = runWithEnv(["--json", "msg", "show", "--id", "cli-local-2"], {
                ZALO_CONFIG_DIR: configDir,
            });
            const show = JSON.parse(showOut);
            assert.equal(show.found, true);
            assert.equal(show.message.msgId, "cli-local-2");
            assert.equal(show.message.content.actionId, "action-cli-local-2");
            assert.match(show.message.rawContentJson, /action-cli-local-2/);

            const contextOut = runWithEnv(
                ["--json", "msg", "context", "--id", "cli-local-2", "--before", "1", "--after", "1"],
                { ZALO_CONFIG_DIR: configDir },
            );
            const context = JSON.parse(contextOut);
            assert.equal(context.found, true);
            assert.equal(context.threadId, "thread_cli_local");
            assert.deepEqual(
                context.before.map((m) => m.msgId),
                ["cli-local-1"],
            );
            assert.equal(context.target.msgId, "cli-local-2");
            assert.deepEqual(
                context.after.map((m) => m.msgId),
                ["cli-local-3"],
            );
            assert.equal(context.after[0].recalled, true);

            const empty = JSON.parse(
                runWithEnv(["--json", "msg", "list", "--thread", "missing_thread"], {
                    ZALO_CONFIG_DIR: configDir,
                }),
            );
            assert.equal(empty.count, 0);
            assert.deepEqual(empty.messages, []);

            try {
                runWithEnv(["--json", "msg", "show", "--id", "missing-message"], {
                    ZALO_CONFIG_DIR: configDir,
                });
                assert.fail("msg show should fail for a missing id");
            } catch (e) {
                const missing = JSON.parse(e.stdout);
                assert.equal(missing.found, false);
                assert.equal(missing.message, null);
            }

            const expectFailure = (args, pattern) => {
                try {
                    runWithEnv(args, { ZALO_CONFIG_DIR: configDir });
                    assert.fail(`${args.join(" ")} should fail`);
                } catch (e) {
                    assert.match(e.stdout || e.message, pattern);
                }
            };

            expectFailure(
                ["--json", "msg", "list", "--limit", "0"],
                /limit must be an integer greater than or equal to 1/,
            );
            expectFailure(
                ["--json", "msg", "list", "--limit", "-1"],
                /limit must be an integer greater than or equal to 1/,
            );
            expectFailure(
                ["--json", "msg", "list", "--limit", "abc"],
                /limit must be an integer greater than or equal to 1/,
            );
            expectFailure(["--json", "msg", "list", "--order", "sideways"], /order must be asc or desc/);
            expectFailure(
                ["--json", "msg", "context", "--id", "cli-local-2", "--before", "-1"],
                /before must be an integer greater than or equal to 0/,
            );
            expectFailure(
                ["--json", "msg", "context", "--id", "cli-local-2", "--after", "-1"],
                /after must be an integer greater than or equal to 0/,
            );
            expectFailure(
                ["--json", "msg", "context", "--id", "cli-local-2", "--before", "abc"],
                /before must be an integer greater than or equal to 0/,
            );
            expectFailure(
                ["--json", "msg", "context", "--id", "cli-local-2", "--after", "abc"],
                /after must be an integer greater than or equal to 0/,
            );
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("executes msg export as default JSON stdout and optional file write", () => {
        const configDir = join(tmpdir(), `zalo-agent-cli-export-${process.pid}-${Date.now()}`);
        const ownId = "cli_export_user";
        const outputPath = join(configDir, "message-export.json");
        try {
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                join(configDir, "accounts.json"),
                JSON.stringify([{ ownId, name: "CLI Export", proxy: null, active: true }]),
                "utf-8",
            );

            execFileSync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    `
                        process.env.ZALO_CONFIG_DIR = ${JSON.stringify(configDir)};
                        const { initDatabase, upsertChat, upsertMessage, upsertStatusBroadcast, closeDatabase } = await import(${JSON.stringify(resolve(import.meta.dirname, "core/db.js"))});
                        await initDatabase(${JSON.stringify(ownId)});
                        upsertChat({ threadId: "thread_cli_export", type: 1, name: "CLI Export Thread", lastMessageTs: 4000 });
                        for (const message of [
                            { msgId: "cli-export-1", threadId: "thread_cli_export", senderId: "friend_cli", senderName: "CLI Friend", ts: 1000, fromMe: 0, text: "export before", msgType: "text" },
                            { msgId: "cli-export-2", threadId: "thread_cli_export", senderId: ${JSON.stringify(ownId)}, senderName: "Me", ts: 2000, fromMe: 1, text: "export image", msgType: "image", localPath: "/tmp/cli-export.png", contentJson: JSON.stringify({ actionId: "action-cli-export-2", media: true }) },
                            { msgId: "cli-export-3", threadId: "thread_cli_export", senderId: "friend_cli", senderName: "CLI Friend", ts: 3000, fromMe: 0, text: null, msgType: "text", recalled: 1 },
                            { msgId: "cli-export-other", threadId: "other_thread", senderId: "friend_cli", senderName: "CLI Friend", ts: 2500, fromMe: 0, text: "other thread", msgType: "text" }
                        ]) upsertMessage(message);
                        upsertStatusBroadcast({ msgId: "cli-export-status", threadId: "status@broadcast", senderId: "status_cli", senderName: "CLI Status", ts: 4000, fromMe: 0, text: "status export", msgType: "text", contentJson: JSON.stringify({ status: true }) });
                        closeDatabase();
                    `,
                ],
                { encoding: "utf-8", timeout: 10000, env: { ...process.env, ZALO_CONFIG_DIR: configDir } },
            );

            const stdout = runWithEnv(
                [
                    "msg",
                    "export",
                    "--thread",
                    "thread_cli_export",
                    "--after",
                    "1500",
                    "--before",
                    "3500",
                    "--asc",
                    "--raw",
                    "--limit",
                    "5",
                ],
                { ZALO_CONFIG_DIR: configDir },
            );
            const exported = JSON.parse(stdout);
            assert.equal(exported.source, "local");
            assert.equal(exported.local_only, true);
            assert.equal(exported.accountId, ownId);
            assert.match(exported.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(exported.filters.threadId, "thread_cli_export");
            assert.equal(exported.filters.since, "1500");
            assert.equal(exported.filters.until, "3500");
            assert.equal(exported.filters.order, "asc");
            assert.equal(exported.filters.includeRaw, true);
            assert.equal(exported.count, 2);
            assert.deepEqual(
                exported.messages.map((m) => m.msgId),
                ["cli-export-2", "cli-export-3"],
            );
            assert.equal(exported.messages[0].threadName, "CLI Export Thread");
            assert.equal(exported.messages[0].localPath, "/tmp/cli-export.png");
            assert.equal(exported.messages[0].content.actionId, "action-cli-export-2");
            assert.match(exported.messages[0].rawContentJson, /action-cli-export-2/);
            assert.equal(exported.messages[1].recalled, true);

            const fileStdout = runWithEnv(["msg", "export", "--thread", "thread_cli_export", "--output", outputPath], {
                ZALO_CONFIG_DIR: configDir,
            });
            assert.equal(fileStdout, "");
            const fileExport = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
            assert.equal(fileExport.count, 3);
            assert.equal(fileExport.messages[0].msgId, "cli-export-3");

            const statusOut = runWithEnv(["msg", "export", "--status", "--limit", "2"], {
                ZALO_CONFIG_DIR: configDir,
            });
            const statusExport = JSON.parse(statusOut);
            assert.equal(statusExport.filters.status, true);
            assert.equal(statusExport.count, 1);
            assert.equal(statusExport.messages[0].msgId, "cli-export-status");

            const empty = JSON.parse(
                runWithEnv(["msg", "export", "--thread", "missing_thread"], {
                    ZALO_CONFIG_DIR: configDir,
                }),
            );
            assert.equal(empty.count, 0);
            assert.deepEqual(empty.messages, []);

            const statsAfter = JSON.parse(runWithEnv(["--json", "store", "stats"], { ZALO_CONFIG_DIR: configDir }));
            assert.equal(statsAfter.counts.messages, 4);
            assert.equal(statsAfter.counts.status_broadcasts, 1);

            const expectFailure = (args, pattern) => {
                try {
                    runWithEnv(args, { ZALO_CONFIG_DIR: configDir });
                    assert.fail(`${args.join(" ")} should fail`);
                } catch (e) {
                    assert.match(e.stdout || e.message, pattern);
                }
            };
            expectFailure(["msg", "export", "--limit", "0"], /limit must be an integer greater than or equal to 1/);
            expectFailure(["msg", "export", "--order", "sideways"], /order must be asc or desc/);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("sync fails on clean state since not logged in", () => {
        try {
            run("sync");
            assert.fail("sync should have failed when not logged in");
        } catch (e) {
            assert.match(e.stdout || e.message, /Not logged in/);
        }
    });
});
