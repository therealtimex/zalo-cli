/**
 * Per-account credential storage at ~/.zalo-agent-cli/accounts/<ownId>/session.json
 * All credential files use 0600 permissions (owner read/write only).
 * Falls back to legacy credentials at credentials/cred_<ownId>.json and auto-migrates them.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CONFIG_DIR = process.env.ZALO_CONFIG_DIR || join(homedir(), ".zalo-agent-cli");
export const CREDENTIALS_DIR = join(CONFIG_DIR, "credentials");

/** Ensure config directories exist. */
function ensureDirs() {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
}

/**
 * Save credentials for a specific account.
 * @param {string} ownId
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @returns {string} File path
 */
export function saveCredentials(ownId, creds) {
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    try {
        chmodSync(accountDir, 0o700);
    } catch {}
    const target = join(accountDir, "session.json");
    writeFileSync(target, JSON.stringify(creds, null, 2), "utf-8");
    try {
        chmodSync(target, 0o600);
    } catch {}
    return target;
}

/**
 * Load credentials for a specific account.
 * @param {string} ownId
 * @returns {object|null}
 */
export function loadCredentials(ownId) {
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    const newTarget = join(accountDir, "session.json");
    const legacyTarget = join(CREDENTIALS_DIR, `cred_${ownId}.json`);

    if (existsSync(newTarget)) {
        try {
            return JSON.parse(readFileSync(newTarget, "utf-8"));
        } catch {
            return null;
        }
    }

    if (existsSync(legacyTarget)) {
        try {
            const creds = JSON.parse(readFileSync(legacyTarget, "utf-8"));
            // Migrate to new layout
            saveCredentials(ownId, creds);
            return creds;
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Delete credentials for a specific account.
 * @param {string} ownId
 * @returns {boolean}
 */
export function deleteCredentials(ownId) {
    const newTarget = join(CONFIG_DIR, "accounts", ownId, "session.json");
    const legacyTarget = join(CREDENTIALS_DIR, `cred_${ownId}.json`);
    let deleted = false;

    if (existsSync(newTarget)) {
        try {
            unlinkSync(newTarget);
            deleted = true;
        } catch {}
    }
    if (existsSync(legacyTarget)) {
        try {
            unlinkSync(legacyTarget);
            deleted = true;
        } catch {}
    }
    return deleted;
}

