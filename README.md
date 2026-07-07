# WApp Starter with SQLite DB

This repository is the reference starter for building a Wingman WApp.

Autopilot's **WApp Starter** flow uses this repo as a template: it clones the starter, creates a new GitHub repository for the new app, pushes `main` and `deployed`, registers the generated app in Autopilot, runs setup, and starts it as a managed web app.

The app itself is a small pipeline chat WApp. It shows the expected shape for a business WApp:

- the WApp owns the browser UI and local app data;
- SQLite is the app database;
- users sign in with Nostr;
- access is controlled by owner/read/edit npub rules;
- Autopilot owns pipeline and agent execution;
- the WApp calls Autopilot with NIP-98 signed requests;
- Autopilot returns work through a WApp webhook.

## Quick Start

Install dependencies:

```bash
bun run setup
```

Run locally:

```bash
bun run start
```

By default the app listens on `PORT` or `3000`.

```bash
PORT=41034 bun run start
```

Run the TypeScript check:

```bash
bun run check
```

There are currently no Bun test files in this starter; `bun test` will report that no tests were found.

## Autopilot Starter Contract

Autopilot expects this repo to behave like a managed WApp template.

Required scripts:

```json
{
  "setup": "bun install",
  "start": "bun src/server.ts"
}
```

`setup` must install all dependencies and be safe to run immediately after cloning. The generated app is started by Autopilot with an assigned `PORT`, so the server must always bind to `process.env.PORT`.

Generated apps should not include a project-level PM2 ecosystem file. Autopilot owns process supervision and injects runtime environment such as `PORT`.

## What The App Does

The first screen asks the user to sign in with a Nostr browser extension or by entering an `nsec` directly. Direct `nsec` login signs the same challenge in the browser without storing or sending the private key. After login, users can create chats, send messages, choose an Autopilot target, choose a pipeline, and inspect local SQLite database operations.

Message flow:

1. Browser signs a login challenge with `window.nostr`, or signs it locally from the entered `nsec`.
2. The WApp stores chats and messages in SQLite.
3. `POST /api/chats/:chatId/messages` creates a pending pipeline run.
4. The browser signs the Autopilot pipeline trigger with NIP-98.
5. The WApp forwards the signed trigger to Autopilot.
6. The Autopilot pipeline does the agent work.
7. The pipeline posts the final response to `POST /api/pipeline-webhook`.
8. The WApp updates the pending assistant message.

`CHAT_WAPP_ALLOW_MOCK=1` keeps the demo usable without a live Autopilot HTTP trigger. Set it to `0` when the app must fail instead of using mock responses.

## Environment

Common local settings:

```txt
PORT=3000
WAPP_DB_PATH=data/chat-wapp.sqlite
CHAT_WAPP_PIPELINE_NAME=chat-wapp-agent-response
WINGMAN_URL=http://127.0.0.1:3256
CHAT_WAPP_ALLOW_MOCK=1
WEBHOOK_SECRET=replace-me
WAPP_OWNER_NPUB=npub1...
WAPP_ALLOWED_NPUBS_JSON=[]
```

See `.env.example` for the full list.

Database path precedence:

```txt
CHAT_WAPP_DB_PATH
WAPP_DB_PATH
SQLITE_PATH
DATABASE_PATH
DATABASE_URL=file:/path/to/db.sqlite
data/chat-wapp.sqlite
```

For CapRover-style deployments, mount a persistent volume and set `WAPP_DB_PATH` to that volume, for example `/data/app.sqlite`.

## SQLite Model

This starter is designed for the simple WApp development model:

- production runs as one deployed app with one persistent SQLite database;
- each developer runs their own local app clone and local SQLite file;
- database changes move through migrations and explicit snapshots;
- production data can be copied back to development by exporting a snapshot and importing it locally.

Startup behavior:

- applies migrations from `src/migrations.ts`;
- creates a pre-migration backup before applying pending migrations to an existing DB;
- checks for staged imports and replaces the DB on startup only after backing up the previous DB.

Settings screen database operations:

- export a SQLite snapshot with `VACUUM INTO`;
- download snapshots;
- stage a snapshot for import;
- upload a SQLite file for staged import;
- clear a pending import.

Imports are staged because SQLite files should not be replaced while the app has an open database connection.

## Access Model

The configured `WAPP_OWNER_NPUB` always has read and edit access.

The app also stores read/edit access rules in SQLite. Until rules exist, the app stays in bootstrap mode so the first signed-in user can configure it. After rules exist:

- read users can log in and use the app;
- edit users can manage settings, access rules, Autopilot targets, and SQLite snapshots/imports.

`WAPP_ALLOWED_NPUBS_JSON` can provide additional allowed npubs through environment configuration.

## Autopilot Targets And Pipelines

Edit users can configure named Autopilot targets in Settings. Each target has:

- label;
- Autopilot base URL;
- default pipeline name.

Pipeline discovery uses browser-mediated NIP-98:

1. The WApp prepares a request for Autopilot `/api/pipelines/definitions`.
2. The browser signs the request.
3. The WApp forwards the signed request to the selected Autopilot target.
4. The UI displays available pipelines.

Chat messages use the selected target and selected pipeline. If no pipeline is selected, the target default is used.

## HTTP API Summary

Browser app routes:

```txt
POST   /api/auth/challenge
POST   /api/auth/verify
GET    /api/me
GET    /api/settings
PUT    /api/settings
GET    /api/chats
POST   /api/chats
GET    /api/chats/:chatId/messages
POST   /api/chats/:chatId/messages
POST   /api/pipeline-runs/:runId/start
POST   /api/pipeline-webhook
```

Autopilot target routes:

```txt
POST   /api/autopilot-targets
PUT    /api/autopilot-targets/current
DELETE /api/autopilot-targets/:targetId
POST   /api/autopilot/pipelines
```

SQLite admin routes:

```txt
GET    /api/db/status
POST   /api/db/snapshots
GET    /api/db/snapshots/:filename/download
POST   /api/db/import
DELETE /api/db/import
```

Agent-to-WApp NIP-98 routes:

```txt
GET   /api/nip98/me
GET   /api/nip98/chats
GET   /api/nip98/chats/:chatId/messages
POST  /api/nip98/chats/:chatId/messages
PATCH /api/nip98/chats/:chatId
```

Read routes require API read access. Edit routes require API edit access. NIP-98 requests verify event kind, signature, URL, method, timestamp, and payload hash for mutating methods.

## Project Layout

```txt
public/             Browser UI
src/server.ts       HTTP server and route handling
src/auth.ts         Nostr login, sessions, access rules, NIP-98 checks
src/db.ts           SQLite connection and data helpers
src/migrations.ts   Database schema migrations and staged import handling
src/db-admin.ts     Snapshot/export/import helpers
src/pipeline.ts     Autopilot trigger and webhook helpers
Wapps-skill.md      Agent-facing guide for building WApps
Dockerfile          CapRover-compatible Bun runtime
captain-definition  CapRover build definition
```

## Creating A New App From This Starter

Use Autopilot's **New App -> WApp Starter** flow.

The intended result is:

1. new local directory under `~/code/<new-app-dir>`;
2. new GitHub repository;
3. `main` and `deployed` branches pushed;
4. branch protection applied where GitHub permissions allow it;
5. app registered in Autopilot;
6. `bun install` run as setup;
7. app started on the assigned Autopilot port.

After generation, change names, domain-specific UI, schema, migrations, API routes, and pipeline payloads in the new repository.

## Deployment Notes

For CapRover:

- keep `captain-definition`;
- keep the Dockerfile;
- set persistent SQLite paths to `/data/...`;
- mount a persistent volume at `/data`;
- provide `WEBHOOK_SECRET`;
- set `WAPP_OWNER_NPUB`;
- configure `WINGMAN_URL` for the Autopilot instance the app should call.

Do not share a live production SQLite file between local developers. Export snapshots and import them deliberately.
