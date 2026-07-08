#!/usr/bin/env node

/**
 * zalo-agent-cli — CLI for Zalo automation with multi-account + proxy support.
 * Entry point: registers all command groups via Commander.js.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { registerLoginCommands } from "./commands/login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
import { registerMsgCommands } from "./commands/msg.js";
import { registerFriendCommands } from "./commands/friend.js";
import { registerGroupCommands } from "./commands/group.js";
import { registerConvCommands } from "./commands/conv.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerPollCommands } from "./commands/poll.js";
import { registerReminderCommands } from "./commands/reminder.js";
import { registerAutoReplyCommands } from "./commands/auto-reply.js";
import { registerQuickMsgCommands } from "./commands/quick-msg.js";
import { registerLabelCommands } from "./commands/label.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerStoreCommands } from "./commands/store.js";
import { registerOACommands } from "./commands/oa.js";
import { registerMCPCommands } from "./commands/mcp.js";
import { autoLogin } from "./core/zalo-client.js";
import { getActive } from "./core/accounts.js";
import { initDatabase } from "./core/db.js";
import { checkForUpdates, selfUpdate } from "./utils/update-check.js";
import { success, error, warning } from "./utils/output.js";

const DISCLAIMER =
    "This tool uses unofficial Zalo APIs (zca-js) — your account may be banned. Use at your own risk. | Tool này dùng API Zalo không chính thức (zca-js) — account có thể bị ban. Tự chịu trách nhiệm.";

const program = new Command();

program
    .name("zalo-agent")
    .description("CLI tool for Zalo automation — multi-account, proxy, bank transfers, QR payments")
    .version(pkg.version)
    .option("--json", "Output results as JSON (machine-readable)")
    .option("--read-only", "Open local cache database in read-only mode")
    .option("--lock-wait <ms>", "Milliseconds to wait for account lock", "5000")
    .hook("preAction", async (thisCommand) => {
        const cmdName = thisCommand.args?.[0] || thisCommand.name();
        const subCmdName = thisCommand.args?.[1];
        const ndjsonMode = thisCommand.args?.some((arg) => arg === "--ndjson");
        // Suppress zca-js internal logs in JSON mode to keep stdout clean for piping
        const localJsonDefault = cmdName === "msg" && subCmdName === "export";
        if (program.opts().json || ndjsonMode || cmdName === "mcp" || localJsonDefault) {
            // Suppress zca-js stdout logs: JSON mode needs clean output, MCP uses stdout as transport
            process.env.ZALO_JSON_MODE = "1";
        } else if (cmdName !== "oa" && cmdName !== "store") {
            // OA commands use official Zalo API — no disclaimer needed
            warning(DISCLAIMER);
            console.log();
        }
        // Auto-login before any command that needs it (skip for login/account/oa commands)
        const skipAutoLogin = [
            "login",
            "account",
            "help",
            "version",
            "update",
            "oa",
            "mcp",
            "doctor",
            "store",
        ].includes(cmdName);
        const localMsgCommands = ["search", "list", "show", "context", "export", "coverage"];
        const localDryRunMsgCommands = ["backfill"];
        const isLocalDryRunMsgCommand =
            cmdName === "msg" &&
            localDryRunMsgCommands.includes(subCmdName) &&
            thisCommand.args?.some((arg) => arg === "--dry-run");
        const isLiveBackfillMsgCommand = cmdName === "msg" && subCmdName === "backfill" && !isLocalDryRunMsgCommand;
        if (cmdName === "msg" && (localMsgCommands.includes(subCmdName) || isLocalDryRunMsgCommand)) {
            const active = getActive();
            if (active?.ownId) {
                await initDatabase(active.ownId, {
                    readonly: true,
                    lockWait: program.opts().lockWait,
                });
            }
        } else if (isLiveBackfillMsgCommand) {
            const active = getActive();
            if (active?.ownId) {
                try {
                    await initDatabase(active.ownId, {
                        readonly: program.opts().readOnly,
                        lockWait: program.opts().lockWait,
                    });
                } catch (e) {
                    error(`Account lock unavailable for msg backfill: ${e.message}`);
                    process.exit(1);
                }
            }
            await autoLogin(program.opts().json || ndjsonMode, {
                readonly: program.opts().readOnly,
                lockWait: program.opts().lockWait,
            });
        } else if (!skipAutoLogin) {
            await autoLogin(program.opts().json, {
                readonly: program.opts().readOnly,
                lockWait: program.opts().lockWait,
            });
        }
        // Non-blocking update check (skip for update command itself)
        if (cmdName !== "update") {
            checkForUpdates(pkg.version, program.opts().json || localJsonDefault);
        }
    });

// Self-update command
program
    .command("update")
    .description("Update zalo-agent-cli to the latest version")
    .action(() => {
        const ok = selfUpdate();
        if (ok) success(`Updated to latest version`);
        else error("Update failed. Try manually: npm install -g zalo-agent-cli@latest");
    });

// Register all command groups
registerLoginCommands(program);
registerMsgCommands(program);
registerFriendCommands(program);
registerGroupCommands(program);
registerConvCommands(program);
registerAccountCommands(program);
registerProfileCommands(program);
registerPollCommands(program);
registerReminderCommands(program);
registerAutoReplyCommands(program);
registerQuickMsgCommands(program);
registerLabelCommands(program);
registerCatalogCommands(program);
registerListenCommand(program);
registerSyncCommand(program);
registerDoctorCommand(program);
registerStoreCommands(program);
registerOACommands(program);
registerMCPCommands(program);

program.parse();
