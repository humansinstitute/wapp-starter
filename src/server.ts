import { join } from "node:path";
import type { Event as NostrEvent } from "nostr-tools";
import {
  addAccessRule,
  canLogin,
  cleanupExpiredAuthRows,
  createChallenge,
  getAccessRules,
  getSession,
  hasAccess,
  normalizePubkey,
  pubkeyToNpub,
  removeAccessRule,
  verifyLoginEvent,
  verifyNip98Request,
} from "./auth.ts";
import { PIPELINE_NAME, PORT, PUBLIC_ORIGIN, WINGMAN_URL } from "./config.ts";
import {
  db,
  deleteAutopilotTarget,
  getAutopilotTarget,
  getCurrentAutopilotTarget,
  getSetting,
  listAutopilotTargets,
  mapChat,
  mapMessage,
  setSetting,
  upsertAutopilotTarget,
  type AccessRole,
  type AppSettings,
  type AutopilotTarget,
  type Message,
} from "./db.ts";
import { clearPendingImport, exportSnapshot, getDbStatus, snapshotPath, stageSnapshotImport, stageUploadedImport } from "./db-admin.ts";
import { buildPipelineTriggerRequest, startPreparedChatPipeline, type PipelineTriggerRequest } from "./pipeline.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

setInterval(cleanupExpiredAuthRows, 15 * 60 * 1000);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (data: string, status = 200) =>
  new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(PUBLIC_DIR, relativePath));
  if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
  const fallback = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await fallback.exists()) return new Response(fallback, { headers: { "cache-control": "no-store" } });
  return text("public/index.html missing", 500);
}

function requireSession(req: Request) {
  const session = getSession(req);
  if (!session) return null;
  return session;
}

function getAppSettings(): AppSettings {
  const targets = listAutopilotTargets();
  const selected = getCurrentAutopilotTarget();
  return {
    autopilotUrl: selected.url || (getSetting("autopilotUrl") || WINGMAN_URL).replace(/\/$/, ""),
    defaultPipeline: selected.defaultPipeline || getSetting("defaultPipeline") || PIPELINE_NAME,
    currentAutopilotTargetId: selected.id,
    autopilotTargets: targets,
  };
}

function normalizeAutopilotUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configuredAutopilotPublicHosts(): Set<string> {
  const hosts = new Set<string>(["rick.runwingman.com"]);
  for (const value of [
    process.env.WAPP_AUTOPILOT_PUBLIC_URL,
    process.env.WINGMAN_PUBLIC_URL,
    process.env.PUBLIC_WINGMAN_URL,
  ]) {
    if (!value?.trim()) continue;
    try {
      hosts.add(new URL(value.trim()).hostname);
    } catch {
      hosts.add(value.trim());
    }
  }
  return hosts;
}

function resolveAutopilotServerUrl(value: string | null | undefined): string {
  const normalized = normalizeAutopilotUrl(value) || WINGMAN_URL;
  try {
    const url = new URL(normalized);
    if (configuredAutopilotPublicHosts().has(url.hostname)) {
      return WINGMAN_URL;
    }
  } catch {
    return WINGMAN_URL;
  }
  return normalized;
}

function normalizePipelineName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRequestedAutopilotTarget(value: unknown): AutopilotTarget {
  const targetId = typeof value === "string" && value.trim() ? value.trim() : getAppSettings().currentAutopilotTargetId;
  return getAutopilotTarget(targetId) || getCurrentAutopilotTarget();
}

function buildAutopilotPipelinesRequest(target = getCurrentAutopilotTarget()) {
  return {
    url: new URL("/api/pipelines/definitions", resolveAutopilotServerUrl(target.url)).toString(),
    method: "GET" as const,
  };
}

function normalizeAccessRole(value: unknown): AccessRole | null {
  return value === "read" || value === "edit" ? value : null;
}

function requireEditSession(req: Request) {
  const session = requireSession(req);
  if (!session) return null;
  return hasAccess(session.pubkey, "edit") ? session : null;
}

function getChatForUser(chatId: string, pubkey: string) {
  const row = db.query("SELECT * FROM chats WHERE id = ?1 AND pubkey = ?2").get(chatId, pubkey) as Record<string, unknown> | null;
  return row ? mapChat(row) : null;
}

function listMessages(chatId: string, pubkey: string): Message[] {
  const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 AND pubkey = ?2 ORDER BY created_at ASC").all(chatId, pubkey) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

function updateChatTitle(chatId: string, title: string) {
  db.query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3").run(title.slice(0, 80), Date.now(), chatId);
}

function webhookOrigin(req: Request): string {
  return PUBLIC_ORIGIN || new URL(req.url).origin;
}

async function handleApi(req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/health" && req.method === "GET") {
    return json({ ok: true, now: new Date().toISOString() });
  }

  if (pathname === "/api/auth/challenge" && req.method === "POST") {
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.pubkey ?? ""));
    if (!pubkey) return json({ error: "pubkey must be a 64-char hex key or npub" }, 400);
    return json({ pubkey, npub: pubkeyToNpub(pubkey), ...createChallenge(pubkey) });
  }

  if (pathname === "/api/auth/verify" && req.method === "POST") {
    const body = await readJson(req);
    const event = body.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return json({ error: "event is required" }, 400);
    const result = verifyLoginEvent(event as NostrEvent);
    return result.ok ? json(result) : json({ error: result.error }, 401);
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({
      pubkey: session.pubkey,
      npub: pubkeyToNpub(session.pubkey),
      expiresAt: session.expiresAt,
      access: {
        login: canLogin(session.pubkey),
        read: hasAccess(session.pubkey, "read"),
        edit: hasAccess(session.pubkey, "edit"),
      },
    });
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ settings: getAppSettings(), accessRules: getAccessRules() });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const targetId = typeof body.autopilotTargetId === "string" && body.autopilotTargetId.trim()
      ? body.autopilotTargetId.trim()
      : getAppSettings().currentAutopilotTargetId;
    const existingTarget = getAutopilotTarget(targetId) || getCurrentAutopilotTarget();
    const label = typeof body.autopilotLabel === "string" && body.autopilotLabel.trim() ? body.autopilotLabel.trim() : existingTarget.label;
    const autopilotUrl = body.autopilotUrl === undefined ? null : normalizeAutopilotUrl(body.autopilotUrl);
    const defaultPipeline = body.defaultPipeline === undefined ? null : normalizePipelineName(body.defaultPipeline);
    if (body.autopilotUrl !== undefined && !autopilotUrl) return json({ error: "autopilotUrl must be a valid http(s) URL" }, 400);
    if (body.defaultPipeline !== undefined && !defaultPipeline) return json({ error: "defaultPipeline is required" }, 400);
    const updated = upsertAutopilotTarget({
      id: existingTarget.id,
      label,
      url: autopilotUrl || existingTarget.url,
      defaultPipeline: defaultPipeline || existingTarget.defaultPipeline,
    });
    setSetting("currentAutopilotTargetId", updated.id);
    return json({ settings: getAppSettings() });
  }

  if (pathname === "/api/autopilot-targets" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "New Autopilot";
    const url = normalizeAutopilotUrl(body.url);
    const defaultPipeline = normalizePipelineName(body.defaultPipeline);
    if (!url) return json({ error: "url must be a valid http(s) URL" }, 400);
    if (!defaultPipeline) return json({ error: "defaultPipeline is required" }, 400);
    const target = upsertAutopilotTarget({ label, url, defaultPipeline });
    setSetting("currentAutopilotTargetId", target.id);
    return json({ target, settings: getAppSettings() }, 201);
  }

  const autopilotTargetMatch = pathname.match(/^\/api\/autopilot-targets\/([^/]+)$/);
  if (autopilotTargetMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const id = decodeURIComponent(autopilotTargetMatch[1]!);
    if (listAutopilotTargets().length <= 1) return json({ error: "at least one Autopilot target is required" }, 409);
    deleteAutopilotTarget(id);
    return json({ ok: true, settings: getAppSettings() });
  }

  if (pathname === "/api/autopilot-targets/current" && req.method === "PUT") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await readJson(req);
    const targetId = typeof body.autopilotTargetId === "string" ? body.autopilotTargetId.trim() : "";
    const target = getAutopilotTarget(targetId);
    if (!target) return json({ error: "Autopilot target not found" }, 404);
    setSetting("currentAutopilotTargetId", target.id);
    return json({ settings: getAppSettings() });
  }

  if (pathname === "/api/access-rules" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ accessRules: getAccessRules() });
  }

  if (pathname === "/api/access-rules" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.npub ?? body.pubkey ?? ""));
    const role = normalizeAccessRole(body.role);
    if (!pubkey) return json({ error: "npub or pubkey is required" }, 400);
    if (!role) return json({ error: "role must be read or edit" }, 400);
    return json({ accessRule: addAccessRule(pubkey, role), accessRules: getAccessRules() }, 201);
  }

  const accessRuleMatch = pathname.match(/^\/api\/access-rules\/(read|edit)\/([^/]+)$/);
  if (accessRuleMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const role = normalizeAccessRole(accessRuleMatch[1]);
    const pubkey = normalizePubkey(decodeURIComponent(accessRuleMatch[2]!));
    if (!role || !pubkey) return json({ error: "valid role and npub/pubkey are required" }, 400);
    removeAccessRule(pubkey, role);
    return json({ ok: true, accessRules: getAccessRules() });
  }

  if (pathname === "/api/autopilot/pipelines-request" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const target = getRequestedAutopilotTarget(url.searchParams.get("autopilotTargetId"));
    return json({ triggerRequest: buildAutopilotPipelinesRequest(target), settings: getAppSettings(), target });
  }

  if (pathname === "/api/autopilot/pipelines" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await readJson(req);
    const target = getRequestedAutopilotTarget(body.autopilotTargetId);
    const request = buildAutopilotPipelinesRequest(target);
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) {
      return json({ requiresAutopilotAuth: true, triggerRequest: request, settings: getAppSettings(), target }, 202);
    }
    const res = await fetch(request.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: autopilotAuthorization,
      },
    });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return json({ error: String(payload.error ?? res.statusText), status: res.status }, 502);
    return json({ pipelines: payload.definitions ?? [], raw: payload, target });
  }

  if (pathname === "/api/db/status" && req.method === "GET") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    return json(getDbStatus());
  }

  if (pathname === "/api/db/snapshots" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    return json({ snapshot: exportSnapshot(String(body.note ?? "")), status: getDbStatus() }, 201);
  }

  const snapshotDownloadMatch = pathname.match(/^\/api\/db\/snapshots\/([^/]+)\/download$/);
  if (snapshotDownloadMatch && req.method === "GET") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const filename = decodeURIComponent(snapshotDownloadMatch[1]!);
    const path = snapshotPath(filename);
    if (!path) return json({ error: "snapshot not found" }, 404);
    return new Response(Bun.file(path), {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
        "cache-control": "no-store",
      },
    });
  }

  if (pathname === "/api/db/import" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "file is required" }, 400);
      return json({ import: await stageUploadedImport(file), status: getDbStatus() }, 202);
    }
    const body = await readJson(req);
    const filename = String(body.filename ?? "");
    if (!filename) return json({ error: "filename is required" }, 400);
    return json({ import: stageSnapshotImport(filename), status: getDbStatus() }, 202);
  }

  if (pathname === "/api/db/import" && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    clearPendingImport();
    return json({ ok: true, status: getDbStatus() });
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const rows = db.query(`
      SELECT c.*, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      WHERE c.pubkey = ?1
      ORDER BY c.updated_at DESC
    `).all(session.pubkey) as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), preview: String(row.preview ?? "") })) });
  }

  if (pathname === "/api/chats" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO chats(id, pubkey, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .run(id, session.pubkey, "New chat", now);
    return json({ chat: getChatForUser(id, session.pubkey) }, 201);
  }

  const chatMessagesMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMessagesMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    return json({ chat, messages: listMessages(chatId, session.pubkey) });
  }

  if (chatMessagesMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    if (content.length > 12000) return json({ error: "content is too long" }, 400);
    const autopilotTarget = getRequestedAutopilotTarget(body.autopilotTargetId);
    const pipelineName = normalizePipelineName(body.pipelineName) || autopilotTarget.defaultPipeline;

    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const localRunId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'user', ?4, 'complete', ?5, ?6)")
      .run(userMessageId, chatId, session.pubkey, content, localRunId, now);
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'assistant', '', 'pending', ?4, ?5)")
      .run(assistantMessageId, chatId, session.pubkey, localRunId, now + 1);
    if (chat.title === "New chat") updateChatTitle(chatId, content.replace(/\s+/g, " ").slice(0, 64));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);

    const history = listMessages(chatId, session.pubkey)
      .filter((msg) => msg.status === "complete" && (msg.role === "user" || msg.role === "assistant"))
      .slice(-30)
      .map((msg) => ({ role: msg.role, content: msg.content, createdAt: msg.createdAt }));

    const webhookUrl = `${webhookOrigin(req)}/api/pipeline-webhook`;
    const settings = getAppSettings();
    const triggerRequest = buildPipelineTriggerRequest({
      chatId,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
      message: content,
      history,
      webhookUrl,
      webhookToken,
      autopilotTargetId: autopilotTarget.id,
      autopilotLabel: autopilotTarget.label,
      autopilotUrl: resolveAutopilotServerUrl(autopilotTarget.url || settings.autopilotUrl),
      pipelineName,
    });
    db.query(`
      INSERT INTO pipeline_runs(
        id,
        chat_id,
        user_message_id,
        assistant_message_id,
        trigger_status,
        webhook_token,
        trigger_payload_json,
        autopilot_target_id,
        autopilot_url,
        pipeline_name,
        created_at,
        updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 'awaiting-user-nip98', ?5, ?6, ?7, ?8, ?9, ?10, ?10)
    `).run(
      localRunId,
      chatId,
      userMessageId,
      assistantMessageId,
      webhookToken,
      JSON.stringify(triggerRequest),
      autopilotTarget.id,
      autopilotTarget.url,
      pipelineName,
      now,
    );

    const autopilotAuthorization = typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "";
    if (!autopilotAuthorization) {
      return json({
        requiresAutopilotAuth: true,
        triggerRequest,
        messages: listMessages(chatId, session.pubkey),
        runId: localRunId,
      }, 202);
    }

    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), localRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, assistantMessageId);
      db.query("UPDATE pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), localRunId);
    }

    return json({ messages: listMessages(chatId, session.pubkey), runId: localRunId }, 202);
  }

  const pipelineStartMatch = pathname.match(/^\/api\/pipeline-runs\/([^/]+)\/start$/);
  if (pipelineStartMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const runId = decodeURIComponent(pipelineStartMatch[1]!);
    const body = await readJson(req);
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) return json({ error: "autopilotAuthorization is required" }, 400);
    const run = db.query(`
      SELECT pr.*, c.pubkey
      FROM pipeline_runs pr
      JOIN chats c ON c.id = pr.chat_id
      WHERE pr.id = ?1 AND c.pubkey = ?2
    `).get(runId, session.pubkey) as Record<string, unknown> | null;
    if (!run) return json({ error: "pipeline run not found" }, 404);
    if (String(run.trigger_status) === "complete") {
      return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
    }
    const rawTrigger = String(run.trigger_payload_json ?? "");
    if (!rawTrigger) return json({ error: "pipeline trigger payload missing" }, 409);
    let triggerRequest: PipelineTriggerRequest;
    try {
      triggerRequest = JSON.parse(rawTrigger) as PipelineTriggerRequest;
    } catch {
      return json({ error: "pipeline trigger payload is invalid" }, 409);
    }
    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, String(run.assistant_message_id));
      db.query("UPDATE pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), runId);
    }
    return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
  }

  if (pathname === "/api/pipeline-webhook" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-chat-wapp-token") || String(body.token ?? "");
    const chatId = String(body.chatId ?? "");
    const response = String(body.response ?? body.message ?? "").trim();
    const runId = String(body.runId ?? "");
    if (!chatId || !token || !response) return json({ error: "chatId, token, and response are required" }, 400);
    const run = db.query("SELECT * FROM pipeline_runs WHERE chat_id = ?1 AND webhook_token = ?2 ORDER BY created_at DESC LIMIT 1")
      .get(chatId, token) as Record<string, unknown> | null;
    if (!run) return json({ error: "webhook target not found" }, 404);
    const now = Date.now();
    db.query("UPDATE messages SET content = ?1, status = 'complete', run_id = ?2 WHERE id = ?3")
      .run(response, runId || String(run.id), String(run.assistant_message_id));
    db.query("UPDATE pipeline_runs SET trigger_status = 'complete', autopilot_run_id = COALESCE(?1, autopilot_run_id), updated_at = ?2 WHERE id = ?3")
      .run(runId || null, now, String(run.id));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ ok: true });
  }

  if (pathname === "/api/nip98/me" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    return json({
      pubkey: verified.pubkey,
      npub: verified.npub,
      access: {
        login: canLogin(verified.pubkey),
        read: hasAccess(verified.pubkey, "read"),
        edit: hasAccess(verified.pubkey, "edit"),
      },
    });
  }

  if (pathname === "/api/nip98/chats" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const rows = db.query(`
      SELECT c.*, u.npub, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      JOIN users u ON u.pubkey = c.pubkey
      ORDER BY c.updated_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), npub: String(row.npub), preview: String(row.preview ?? "") })) });
  }

  const nip98ChatMessagesMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)\/messages$/);
  if (nip98ChatMessagesMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT c.*, u.npub FROM chats c JOIN users u ON u.pubkey = c.pubkey WHERE c.id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC").all(chatId) as Record<string, unknown>[];
    return json({ chat: { ...mapChat(chat), npub: String(chat.npub) }, messages: rows.map(mapMessage) });
  }

  if (nip98ChatMessagesMatch && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const role = ["assistant", "system", "user"].includes(String(body.role)) ? String(body.role) : "system";
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'complete', ?6, ?7)")
      .run(id, chatId, String(chat.pubkey), role, content, String(body.runId ?? ""), now);
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ message: mapMessage(db.query("SELECT * FROM messages WHERE id = ?1").get(id) as Record<string, unknown>) }, 201);
  }

  const nip98ChatMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)$/);
  if (nip98ChatMatch && req.method === "PATCH") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMatch[1]!);
    const body = await readJson(req);
    const title = String(body.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, 400);
    updateChatTitle(chatId, title);
    const row = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!row) return json({ error: "chat not found" }, 404);
    return json({ chat: mapChat(row) });
  }

  return null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(req, url);
      if (response) return response;
      return json({ error: "not found" }, 404);
    }
    return serveStatic(url.pathname);
  },
});

console.log(`chat-wapp listening on ${server.url}`);
