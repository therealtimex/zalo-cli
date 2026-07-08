/**
 * Store command — inspect and safely prune the local SQLite/media cache.
 */

import fs from "node:fs";
import { join } from "node:path";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { cleanupLocalStore, getLocalStoreStats, initDatabase, planLocalStoreCleanup } from "../core/db.js";
import { output, success, error, info, warning } from "../utils/output.js";

const LOCAL_ONLY_TEXT =
    "Local cache only: this command does not delete Zalo messages, leave groups, or call remote APIs.";

function getActiveAccount() {
    const active = getActive();
    if (!active?.ownId) throw new Error("No active account. Run: zalo-agent account login");
    return active;
}

function getStorePath(ownId) {
    return join(CONFIG_DIR, "accounts", ownId, "zalo.db");
}

async function openStore(ownId, { readonly, createIfMissing = false, lockWait = 5000 } = {}) {
    const dbPath = getStorePath(ownId);
    if (!fs.existsSync(dbPath) && !createIfMissing) return { opened: false, dbPath };
    await initDatabase(ownId, { readonly, lockWait });
    return { opened: true, dbPath };
}

function buildStatsPayload(active, dbPath, exists) {
    return {
        source: "local",
        local_only: true,
        account: {
            own_id: active.ownId,
            name: active.name || null,
        },
        store: {
            exists,
            path: dbPath,
        },
        ...getLocalStoreStats(),
    };
}

function renderStatsHuman(stats) {
    success("Local store stats");
    info(LOCAL_ONLY_TEXT);
    info(`Account: ${stats.account.own_id}${stats.account.name ? ` (${stats.account.name})` : ""}`);
    info(`Store: ${stats.store.exists ? stats.store.path : "missing"}`);
    info(
        `Rows: chats=${stats.counts.chats}, contacts=${stats.counts.contacts}, groups=${stats.counts.groups}, group_participants=${stats.counts.group_participants}`,
    );
    info(
        `Messages: messages=${stats.counts.messages}, recalled=${stats.counts.recalled_messages}, status_broadcasts=${stats.counts.status_broadcasts}, media_linked=${stats.counts.media_linked_messages}`,
    );
    info(
        `Downloaded media: files=${stats.downloaded_media.files}, bytes=${stats.downloaded_media.bytes}, missing_paths=${stats.downloaded_media.missing_files}`,
    );
}

function renderCleanupHuman(result) {
    warning(LOCAL_ONLY_TEXT);
    if (result.dry_run) success("Dry run complete; no local cache rows were deleted");
    else success("Local cache cleanup complete");
    info(
        `Criteria: ${result.criteria.thread_id ? `thread=${result.criteria.thread_id}` : "all threads"}${
            result.criteria.days ? `, older_than_days=${result.criteria.days}` : ""
        }`,
    );
    if (result.criteria.cutoff_at) info(`Cutoff: ${result.criteria.cutoff_at}`);
    info(
        `Planned: chats=${result.planned.chats}, groups=${result.planned.groups}, group_participants=${result.planned.group_participants}, messages=${result.planned.messages}, status_broadcasts=${result.planned.status_broadcasts}`,
    );
    info(
        `Deleted: chats=${result.deleted.chats}, groups=${result.deleted.groups}, group_participants=${result.deleted.group_participants}, messages=${result.deleted.messages}, status_broadcasts=${result.deleted.status_broadcasts}`,
    );
}

function cleanupOptions(opts) {
    const testNow = process.env.ZALO_AGENT_TEST_NOW ? Number(process.env.ZALO_AGENT_TEST_NOW) : null;
    return {
        days: opts.days,
        threadId: opts.thread,
        dryRun: !!opts.dryRun,
        confirm: !!opts.confirm,
        now: Number.isFinite(testNow) ? testNow : undefined,
    };
}

export function registerStoreCommands(program) {
    const store = program.command("store").description("Inspect and safely clean up the local cache store");

    store
        .command("stats")
        .description("Show local cache row and downloaded media counts")
        .action(async () => {
            const jsonMode = program.opts().json;
            if (jsonMode) process.env.ZALO_JSON_MODE = "1";
            try {
                const active = getActiveAccount();
                const { opened, dbPath } = await openStore(active.ownId, { readonly: true });
                output(buildStatsPayload(active, dbPath, opened), jsonMode, renderStatsHuman);
            } catch (e) {
                error(`Store stats failed: ${e.message}`);
                process.exit(1);
            }
        });

    store
        .command("cleanup")
        .description("Prune local cache rows by age or thread without touching remote Zalo data")
        .option("--days <days>", "Delete local message rows older than this many days")
        .option(
            "--thread <threadId>",
            "Limit cleanup to a cached thread ID; without --days, remove the whole cached thread",
        )
        .option("--dry-run", "Show what would be deleted without changing the local cache")
        .option("--confirm", "Required to perform deletion")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            if (jsonMode) process.env.ZALO_JSON_MODE = "1";
            try {
                const active = getActiveAccount();
                if (program.opts().readOnly) {
                    throw new Error("store cleanup is blocked by --read-only");
                }
                const options = cleanupOptions(opts);
                const readonly = options.dryRun;
                await openStore(active.ownId, {
                    readonly,
                    createIfMissing: false,
                    lockWait: Number.parseInt(program.opts().lockWait, 10),
                });
                const result = options.dryRun ? planLocalStoreCleanup(options) : cleanupLocalStore(options);
                if (options.dryRun)
                    result.deleted = { chats: 0, groups: 0, group_participants: 0, messages: 0, status_broadcasts: 0 };
                result.dry_run = options.dryRun;
                output(
                    {
                        source: "local",
                        local_only: true,
                        account: {
                            own_id: active.ownId,
                            name: active.name || null,
                        },
                        ...result,
                    },
                    jsonMode,
                    renderCleanupHuman,
                );
            } catch (e) {
                error(`Store cleanup failed: ${e.message}`);
                process.exit(1);
            }
        });
}
