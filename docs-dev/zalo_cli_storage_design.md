# Storage Design for zalo-cli (zalo.db)

This document provides an investigation of the storage architecture of [wacli](file:///Users/realtimex/github/wacli) and translates its design patterns into a concrete blueprint for implementing local persistent storage in [zalo-cli](file:///Users/realtimex/github/zalo-cli).

---

## 🔍 Comparative Analysis: wacli vs. zalo-cli

| Feature | `wacli` (Go) | `zalo-cli` (Node.js ESM) |
| :--- | :--- | :--- |
| **Authentication Engine** | [whatsmeow](https://github.com/tulir/whatsmeow) | [zca-js](https://github.com/PhucMPham/zca-js) |
| **Local DB Engine** | SQLite (`wacli.db`) via FTS5 trigger-synced tables | *None (data exists in-memory only)* |
| **Account Isolation** | `~/.wacli/accounts/<account_name>/` (separate DBs) | `~/.zalo-agent-cli/credentials/` (isolated JSONs) |
| **Concurrency Safeguard** | UNIX flock on `LOCK` file, timeout flags | *None (susceptible to duplicate session disconnects)* |
| **Message Retrieval** | Cached locally first; fills gaps on demand | WebSocket history paging or live WebSocket listening |
| **Offline Capabilities** | Full reading, listing, and searching offline | None |

---

## 📁 1. Directory Layout & File Permissions

To prevent merging multi-account data and keep credentials secure, we should adapt `wacli`'s directory structures.

### Proposed Structure
```
~/.zalo-agent-cli/
├── accounts.json                     # Global account registry & active state
├── accounts/                         # New isolated account data folders
│   └── <ownId>/                      # Folder named by user's Zalo UID
│       ├── LOCK                      # Exclusive write-lock file for this account
│       ├── session.json              # zca-js credentials (imei, cookie, useragent)
│       └── zalo.db                   # SQLite database for this account
└── credentials/                      # Legacy credentials (for fallback)
    └── cred_<ownId>.json
```

### File Permissions (Owner-Only Access)
All files and directories must be locked down to owner-only read/write access to protect personal messages and user IDs:
*   Directories: `0700` (`rwx------`)
*   Files (`zalo.db`, `session.json`, `LOCK`): `0600` (`rw-------`)

*In Node.js, this is achieved during directory creation and file writes:*
```javascript
import fs from "fs";
fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(dbPath, "", { mode: 0o600 });
```

---

## 💾 2. Database Engine & Configuration

### SQLite Package Choice
For a Node.js CLI tool targeting `Node >= 20`, we recommend **`better-sqlite3`** (or `sqlite3` + a wrapper). `better-sqlite3` is preferred because:
1.  **Synchronous API:** CLI tools run sequentially; async-await boilerplate is reduced.
2.  **Performance:** Significantly faster execution speeds than standard asynchronous `sqlite3`.
3.  **Self-Contained:** Stored as a single binary extension.

### SQLite Optimization Pragmas
To allow concurrent reads (e.g. running queries while the `listen` daemon is writing) without blocking, we must enable **Write-Ahead Logging (WAL)**, matching `wacli`'s database setup:

```javascript
import Database from "better-sqlite3";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");
db.pragma("foreign_keys = ON");
```

---

## 📐 3. Database Schema Design (`zalo.db`)

The SQLite schema targets five key areas: Chats/Conversations, Contacts/Friends, Messages, Groups, and Group Participants.

```sql
-- 1. Chats / Threads (cached channels for DM or Groups)
CREATE TABLE IF NOT EXISTS chats (
    thread_id TEXT PRIMARY KEY,
    type INTEGER NOT NULL,          -- 0 = User (DM), 1 = Group
    name TEXT,
    last_message_ts INTEGER,        -- Unix timestamp in ms
    unread_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER NOT NULL DEFAULT 0, -- Unix timestamp in ms
    updated_at INTEGER NOT NULL
);

-- 2. Contacts / Friends (Zalo users)
CREATE TABLE IF NOT EXISTS contacts (
    user_id TEXT PRIMARY KEY,
    phone_number TEXT,
    display_name TEXT,
    zalo_name TEXT,
    avatar_url TEXT,
    is_friend INTEGER NOT NULL DEFAULT 0,
    last_active INTEGER,            -- Unix timestamp in ms
    updated_at INTEGER NOT NULL
);

-- 3. Groups
CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    name TEXT,
    owner_id TEXT,
    creator_id TEXT,
    created_ts INTEGER,             -- Unix timestamp in ms
    member_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES chats(thread_id) ON DELETE CASCADE
);

-- 4. Group Participants
CREATE TABLE IF NOT EXISTS group_participants (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT,                      -- owner | admin | member
    joined_at INTEGER,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES contacts(user_id) ON DELETE CASCADE
);

-- 5. Messages
CREATE TABLE IF NOT EXISTS messages (
    msg_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    sender_id TEXT,
    sender_name TEXT,
    ts INTEGER NOT NULL,            -- Unix timestamp in ms
    from_me INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    msg_type TEXT,                  -- text | image | file | voice | sticker | link | video | etc.
    content_json TEXT,              -- Full raw API object JSON for future compatibility
    local_path TEXT,                -- Path to downloaded attachment (if any)
    recalled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (thread_id) REFERENCES chats(thread_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

-- 6. Full-Text Search (FTS5) for fast offline message search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    msg_id UNINDEXED,
    thread_id UNINDEXED,
    sender_name,
    text,
    content = 'messages',
    content_rowid = 'rowid'
);

-- Triggers to automatically sync messages with messages_fts
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, msg_id, thread_id, sender_name, text)
    VALUES (new.rowid, new.msg_id, new.thread_id, new.sender_name, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, msg_id, thread_id, sender_name, text)
    VALUES ('delete', old.rowid, old.msg_id, old.thread_id, old.sender_name, old.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, msg_id, thread_id, sender_name, text)
    VALUES ('delete', old.rowid, old.msg_id, old.thread_id, old.sender_name, old.text);
    INSERT INTO messages_fts(rowid, msg_id, thread_id, sender_name, text)
    VALUES (new.rowid, new.msg_id, new.thread_id, new.sender_name, new.text);
END;
```

---

## 🔄 4. Synchronisation & Caching Mechanics

`wacli` combines passive event caching and active query-time caching. We should follow this model:

### Passive Caching (via Daemon Listener)
When running the `zalo-agent listen` daemon, every event received over the WebSocket is stored immediately:
1.  **On `message` event:** Write/Upsert message to `messages`. Check if `chats` exists; if not, insert a placeholder chat.
2.  **On `reaction` / `undo` events:** Update `messages` table (e.g. setting `recalled = 1` or appending reactions).
3.  **On `friend_event` / `group_event`:** Upsert contact details or modify group membership records in `group_participants`.

### Active Caching (on CLI query)
When commands like `conv recent` or `friend list` are run:
1.  **Check network availability:** If connected, query Zalo APIs.
2.  **Upsert to DB:** For each record retrieved, run an `INSERT OR REPLACE` query to cache details locally.
3.  **Read from DB:** Query the local SQLite database and output the unified records to the user.
4.  **Offline fallback:** If Zalo servers are unreachable or the session is temporarily stale, fall back and query the SQLite database directly, outputting cached data with a warning notice.

### Backfilling Message History
`zalo-agent msg history <threadId>` can load data incrementally:
1.  Query local `messages` table first.
2.  If the local count is smaller than `--limit`, connect via WebSocket and use `requestOldMessages` to request paginated historical blocks from Zalo.
3.  Insert retrieved page rows into the database.
4.  Sort and display messages directly from SQLite.

---

## 🔒 5. Concurrency & Write Lock Management

CLI tools run in independent shell invocations. If two command scripts attempt to open the write-ahead log database or authenticate the same Zalo cookie concurrently, they could disrupt active sockets or corrupt indices.

### The Lockfile Strategy
We can enforce a simple, cross-platform locking wrapper around the account's directory:
*   Before any command writes to `zalo.db` or starts the WebSocket listener, it must acquire a file lock.
*   We can implement a lockfile helper using `proper-lockfile` (or atomic operations using native Node `fs` API).

```javascript
import fs from "fs";
import { join } from "path";

export class AccountLock {
    constructor(accountDir) {
        this.lockPath = join(accountDir, "LOCK");
        this.lockFileHandle = null;
    }

    async acquire(timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                // 'wx' flag opens for writing and fails if file already exists
                this.lockFileHandle = fs.openSync(this.lockPath, "wx");
                // Write PID to lock file
                fs.writeSync(this.lockFileHandle, `pid=${process.pid}\nacquired_at=${new Date().toISOString()}`);
                return true;
            } catch (err) {
                if (err.code !== "EEXIST") throw err;
                // Check if process in lockfile is still alive
                try {
                    const content = fs.readFileSync(this.lockPath, "utf-8");
                    const pidMatch = content.match(/pid=(\d+)/);
                    if (pidMatch) {
                        const pid = parseInt(pidMatch[1], 10);
                        // Send 0 signal to check if process exists
                        process.kill(pid, 0);
                    }
                } catch (killErr) {
                    // process.kill throws ESRCH if pid doesn't exist; lock is stale
                    if (killErr.code === "ESRCH") {
                        try { fs.unlinkSync(this.lockPath); } catch {}
                        continue;
                    }
                }
                // Wait and retry
                await new Promise(r => setTimeout(r, 200));
            }
        }
        throw new Error("Could not acquire account lock. Is another zalo-agent process running?");
    }

    release() {
        if (this.lockFileHandle) {
            try {
                fs.closeSync(this.lockFileHandle);
                fs.unlinkSync(this.lockPath);
            } catch {}
            this.lockFileHandle = null;
        }
    }
}
```

---

## 🚀 6. Code Refactoring Map

To integrate this storage model into the existing `zalo-cli` codebase, the following adjustments are proposed:

### Phase 1: Storage Layer Definition
1.  Create `src/core/db.js` to initialize, open, and query the SQLite database.
2.  Add a `migration.js` routine that automatically creates tables and trigger-based FTS indices if they do not exist.
3.  Add `src/core/lock.js` using the atomic file lock pattern.

### Phase 2: Updating Commands to Write/Read Cache
1.  **`src/commands/listen.js`**: Update to write incoming message payloads into `messages`, `chats`, and `contacts` in the database.
2.  **`src/commands/conv.js` (`recent`)**: Modify to query Zalo Web, insert/replace chats/contacts inside `zalo.db`, and retrieve them from the DB.
3.  **`src/commands/friend.js` (`list`/`search`)**: Modify to retrieve and update local `contacts` table.
4.  **`src/commands/msg.js` (`history`)**: Modify to implement the incremental pagination check against SQLite first, writing new pages fetched over WebSocket to the DB.

### Phase 3: CLI Option Hooks
Update `src/index.js` to support read-only flags or lock-wait overrides:
```javascript
program
    .option("--read-only", "Open local cache database in read-only mode")
    .option("--lock-wait <ms>", "Milliseconds to wait for account lock", "5000");
```
When `--read-only` is provided, open SQLite using `readonly` mode and skip lock acquisition:
```javascript
const db = new Database(dbPath, { readonly: true });
```
