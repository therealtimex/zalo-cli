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

    it("sync fails on clean state since not logged in", () => {
        try {
            run("sync");
            assert.fail("sync should have failed when not logged in");
        } catch (e) {
            assert.match(e.stdout || e.message, /Not logged in/);
        }
    });
});
