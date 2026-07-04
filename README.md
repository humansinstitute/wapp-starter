# Reference Chat WApp

A reference WApp that logs in with a Nostr browser extension, stores chats in local SQLite, starts a selected Wingman/Autopilot pipeline for each user message, and receives the agent answer through a webhook.

It is also the starter pattern for Business WApps: the WApp owns local UI/data, Autopilot owns pipeline/agent execution, and both sides can talk over NIP-98 APIs.

Agents that need to build or integrate WApps can install or copy the bundled skill guide: `Wapps-skill.md`.

## Flow

1. Browser signs a login challenge with `window.nostr`.
2. Messages are stored in `data/chat-wapp.sqlite`.
3. `POST /api/chats/:chatId/messages` starts the selected Autopilot target and pipeline.
4. Pipeline input includes `message`, `history`, `chatId`, and `webhook`.
5. The pipeline agent posts the answer to `POST /api/pipeline-webhook`.

`CHAT_WAPP_ALLOW_MOCK=1` keeps the demo usable before the Autopilot HTTP trigger route is live. Set it to `0` once Autopilot is restarted with the HTTP trigger update.

## Local Settings

Signed-in users with edit access can configure these from Settings:

- Named Autopilot targets, each with a label, base URL, and default chat pipeline.
- The current target used for chat and pipeline discovery.
- Read and edit npub groups.
- SQLite snapshot export and staged import.

Settings are stored in the local SQLite database. Until access rules are configured, the app stays in bootstrap mode so the first signed-in user can configure it. After rules exist, users can log in when they have read or edit access. Edit access can also configure settings and access rules. The configured `WAPP_OWNER_NPUB` always has read and edit access.

## SQLite Reference DB

The app is designed for the simple WApp development model:

- production runs as one CapRover app with one persistent SQLite volume;
- each developer runs a local branch with a local SQLite file;
- dev/test databases move through explicit snapshots, not shared raw SQLite writes.

The database path follows this precedence:

```txt
CHAT_WAPP_DB_PATH
WAPP_DB_PATH
SQLITE_PATH
DATABASE_PATH
DATABASE_URL=file:/path/to/db.sqlite
data/chat-wapp.sqlite
```

On startup the app applies pending migrations from `src/migrations.ts`. If migrations are pending and the DB exists, it creates a pre-migration SQLite backup first.

Edit users can export snapshots from Settings. Snapshot export uses SQLite `VACUUM INTO`, so it captures a consistent DB file even when WAL mode is enabled.

Imports are staged. Uploading a SQLite file or staging an existing snapshot writes a pending import marker. The app replaces the live DB on next startup, after first copying the previous DB to the backup directory. This avoids replacing an open SQLite connection.

## NIP-98 APIs

Autopilot pipeline discovery uses the browser NIP-98 signer:

- `POST /api/autopilot/pipelines` returns a NIP-98 signing request when no Autopilot authorization is provided.
- The browser signs that request and retries the same WApp endpoint.
- The WApp forwards the signed request to the selected Autopilot `/api/pipelines/definitions`.

Autopilot targets:

```txt
POST   /api/autopilot-targets
PUT    /api/autopilot-targets/current
DELETE /api/autopilot-targets/:targetId
```

SQLite reference operations:

```txt
GET    /api/db/status
POST   /api/db/snapshots
GET    /api/db/snapshots/:filename/download
POST   /api/db/import
DELETE /api/db/import
```

Agent-to-WApp API routes:

```txt
GET   /api/nip98/me
GET   /api/nip98/chats
GET   /api/nip98/chats/:chatId/messages
POST  /api/nip98/chats/:chatId/messages
PATCH /api/nip98/chats/:chatId
```

Read routes require API read access. Edit routes require API edit access. All NIP-98 requests verify event kind, signature, URL, method, timestamp, and payload hash for mutating methods.
