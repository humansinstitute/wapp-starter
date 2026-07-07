import { derivePubkeyFromNsec, signEventWithNsec, signLoginChallengeWithNsec } from "/nostr-login.js";

const PROFILE_CACHE_KEY = "chat_wapp_profiles_v1";
const PIPELINES_CACHE_KEY = "chat_wapp_pipelines_v1";
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const state = {
  token: localStorage.getItem("chat_wapp_token") || "",
  me: null,
  chats: [],
  settings: null,
  accessRules: [],
  dbStatus: null,
  pipelines: loadPipelinesCache(),
  activeChatId: localStorage.getItem("chat_wapp_chat") || "",
  activeAutopilotTargetId: localStorage.getItem("chat_wapp_autopilot_target") || "",
  activePipelineName: localStorage.getItem("chat_wapp_pipeline") || "",
  pollTimer: null,
  route: window.location.pathname,
  profiles: loadProfileCache(),
  directNsec: "",
};

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    return payload;
  });
}

function setStatus(text) {
  $("status").textContent = text;
}

function loadProfileCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadPipelinesCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PIPELINES_CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePipelinesCache() {
  localStorage.setItem(PIPELINES_CACHE_KEY, JSON.stringify(state.pipelines));
}

function saveProfileCache() {
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(state.profiles));
}

function cachedProfile(pubkey) {
  const entry = state.profiles[pubkey];
  if (!entry || Date.now() - Number(entry.cachedAt || 0) > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

function displayNameForRule(rule, profile) {
  return profile?.displayName || profile?.name || `${rule.npub.slice(0, 12)}...${rule.npub.slice(-6)}`;
}

function profileInitial(rule, profile) {
  return displayNameForRule(rule, profile).slice(0, 1).toUpperCase();
}

function appRoute() {
  return ["/act", "/chat", "/settings"].includes(window.location.pathname) ? window.location.pathname : "/";
}

function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  state.route = path;
  void renderRoute();
}

function showOnly(id) {
  for (const sectionId of ["login", "home", "actPage", "settingsPage", "shell"]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function renderRoute() {
  state.route = appRoute();
  if (!state.token || !state.me) {
    stopPolling();
    showOnly("login");
    return;
  }

  if (state.route === "/chat") {
    showOnly("shell");
    await loadChatScreen();
    startPolling();
    return;
  }

  stopPolling();
  if (state.route === "/settings") {
    showOnly("settingsPage");
    await loadSettings();
    return;
  }

  if (state.route === "/act") {
    showOnly("actPage");
    return;
  }

  showOnly("home");
}

async function finishLoginWithSigner(getPubkey, signChallenge) {
  $("loginError").textContent = "";
  const pubkey = await getPubkey();
  const challenge = await api("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ pubkey }),
  });
  const event = await signChallenge(challenge);
  const result = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ event }),
  });
  state.token = result.token;
  state.me = result;
  localStorage.setItem("chat_wapp_token", result.token);
  if (window.location.pathname !== "/") history.pushState({}, "", "/");
  await bootApp();
}

async function login() {
  if (!window.nostr) {
    $("loginError").textContent = "No Nostr browser extension was found.";
    return;
  }
  try {
    state.directNsec = "";
    await finishLoginWithSigner(
      () => window.nostr.getPublicKey(),
      (challenge) => window.nostr.signEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", challenge.nonce], ["client", "chat-wapp"]],
        content: challenge.content,
      }),
    );
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function loginWithNsec() {
  $("loginError").textContent = "";
  const input = $("nsecInput");
  const nsec = input.value.trim();
  try {
    await finishLoginWithSigner(
      () => derivePubkeyFromNsec(nsec),
      (challenge) => signLoginChallengeWithNsec(nsec, challenge),
    );
    state.directNsec = nsec;
    input.value = "";
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function bootApp() {
  try {
    state.me = await api("/api/me");
    $("npub").textContent = state.me.npub;
    await renderRoute();
  } catch {
    logout();
  }
}

function logout() {
  state.token = "";
  state.me = null;
  state.activeChatId = "";
  state.directNsec = "";
  localStorage.removeItem("chat_wapp_token");
  localStorage.removeItem("chat_wapp_chat");
  $("nsecInput").value = "";
  stopPolling();
  showOnly("login");
}

async function loadChatScreen() {
  await loadRuntimeSettings();
  await loadChats();
  if (!state.activeChatId || !state.chats.find((chat) => chat.id === state.activeChatId)) {
    if (state.chats[0]) state.activeChatId = state.chats[0].id;
    else await newChat();
  }
  await loadActiveChat();
}

async function loadChats() {
  const payload = await api("/api/chats");
  state.chats = payload.chats || [];
  renderChats();
}

async function loadSettings() {
  await loadRuntimeSettings();
  if (state.me?.access?.edit) await loadDbStatus().catch((error) => setStatus(error.message));
  renderSettings();
  renderAutopilotTargets();
  renderPipelineOptions();
  renderAccessRules();
  renderDbStatus();
}

async function loadRuntimeSettings() {
  const payload = await api("/api/settings");
  state.settings = payload.settings;
  state.accessRules = payload.accessRules || [];
  if (!state.activeAutopilotTargetId) {
    state.activeAutopilotTargetId = state.settings?.currentAutopilotTargetId || "";
    if (state.activeAutopilotTargetId) localStorage.setItem("chat_wapp_autopilot_target", state.activeAutopilotTargetId);
  }
  const target = currentTarget();
  if (!state.activePipelineName) {
    state.activePipelineName = target?.defaultPipeline || state.settings?.defaultPipeline || "";
    if (state.activePipelineName) localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
  }
  renderChatRunControls();
}

function renderSettings() {
  const target = currentTarget() || state.settings?.autopilotTargets?.[0] || null;
  $("autopilotLabelInput").value = target?.label || "";
  $("autopilotUrlInput").value = target?.url || state.settings?.autopilotUrl || "";
  $("pipelineInput").value = target?.defaultPipeline || state.settings?.defaultPipeline || "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const id of [
    "autopilotTargetSelect",
    "autopilotLabelInput",
    "autopilotUrlInput",
    "pipelineInput",
    "pipelineSelect",
    "saveSettingsButton",
    "newTargetButton",
    "deleteTargetButton",
    "accessNpubInput",
    "accessRoleSelect",
    "addAccessButton",
    "refreshDbButton",
    "exportDbButton",
    "importDbInput",
    "importDbButton",
    "clearImportButton",
  ]) {
    $(id).disabled = !canEdit;
  }
}

function currentTarget() {
  const targets = state.settings?.autopilotTargets || [];
  return targets.find((target) => target.id === state.activeAutopilotTargetId)
    || targets.find((target) => target.id === state.settings?.currentAutopilotTargetId)
    || targets[0]
    || null;
}

function renderAutopilotTargets() {
  const targets = state.settings?.autopilotTargets || [];
  for (const id of ["autopilotTargetSelect", "chatAutopilotSelect"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = "";
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.label;
      select.appendChild(option);
    }
    select.value = currentTarget()?.id || "";
  }
}

function renderPipelineOptions() {
  for (const id of ["pipelineSelect", "chatPipelineSelect"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = state.pipelines.length ? "Select a pipeline" : "Use target default";
    select.appendChild(empty);
    for (const pipeline of state.pipelines) {
      const option = document.createElement("option");
      option.value = pipeline.name || pipeline.slug || pipeline.id;
      option.textContent = `${pipeline.name || pipeline.slug || pipeline.id}${pipeline.version ? ` v${pipeline.version}` : ""}`;
      select.appendChild(option);
    }
    const selected = id === "chatPipelineSelect" ? state.activePipelineName : $("pipelineInput").value;
    if (selected) select.value = selected;
  }
}

function renderChatRunControls() {
  renderAutopilotTargets();
  renderPipelineOptions();
  const target = currentTarget();
  if (target && !$("chatPipelineSelect").value && !state.activePipelineName) {
    state.activePipelineName = target.defaultPipeline;
    localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
  }
  $("chatPipelineSelect").value = state.activePipelineName || target?.defaultPipeline || "";
}

function renderAccessRules() {
  const list = $("accessList");
  list.innerHTML = "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const rule of state.accessRules) {
    const item = document.createElement("div");
    item.className = "accessItem";
    item.dataset.pubkey = rule.pubkey;
    const profile = cachedProfile(rule.pubkey);
    const identity = document.createElement("div");
    identity.className = "accessIdentity";
    const avatar = document.createElement("div");
    avatar.className = "accessAvatar";
    if (profile?.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
    const label = document.createElement("div");
    label.className = "accessLabel";
    const name = document.createElement("strong");
    name.textContent = displayNameForRule(rule, profile);
    const meta = document.createElement("span");
    meta.textContent = `${rule.role === "edit" ? "Edit" : "Read"} - ${rule.npub}`;
    label.append(name, meta);
    identity.append(avatar, label);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Remove";
    button.disabled = !canEdit;
    button.addEventListener("click", () => removeAccessRule(rule));
    item.append(identity, button);
    list.appendChild(item);
    if (!profile) {
      void resolveProfile(rule).then(() => updateAccessRuleProfile(rule));
    }
  }
}

function updateAccessRuleProfile(rule) {
  const item = $(`accessList`).querySelector(`[data-pubkey="${CSS.escape(rule.pubkey)}"]`);
  const profile = cachedProfile(rule.pubkey);
  if (!item || !profile) return;
  const avatar = item.querySelector(".accessAvatar");
  const name = item.querySelector(".accessLabel strong");
  if (avatar) {
    avatar.innerHTML = "";
    if (profile.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
  }
  if (name) name.textContent = displayNameForRule(rule, profile);
}

async function resolveProfile(rule) {
  const existing = cachedProfile(rule.pubkey);
  if (existing) return existing;
  const profile = await fetchNostrProfile(rule.pubkey).catch(() => null);
  const normalized = {
    pubkey: rule.pubkey,
    name: typeof profile?.name === "string" ? profile.name : "",
    displayName: typeof profile?.display_name === "string" ? profile.display_name : typeof profile?.displayName === "string" ? profile.displayName : "",
    picture: typeof profile?.picture === "string" ? profile.picture : "",
    cachedAt: Date.now(),
  };
  state.profiles[rule.pubkey] = normalized;
  saveProfileCache();
  return normalized;
}

async function fetchNostrProfile(pubkey) {
  const attempts = PROFILE_RELAYS.map((relay) => fetchProfileFromRelay(relay, pubkey));
  const result = await Promise.any(attempts);
  return result;
}

function fetchProfileFromRelay(relayUrl, pubkey) {
  return new Promise((resolve, reject) => {
    const subId = `profile-${pubkey.slice(0, 8)}-${Math.random().toString(16).slice(2)}`;
    let bestEvent = null;
    let settled = false;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    }, 2500);

    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        socket.close();
      } catch {}
      if (error || !value) reject(error || new Error("profile not found"));
      else resolve(value);
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === "EVENT" && message[1] === subId && message[2]?.kind === 0) {
        if (!bestEvent || Number(message[2].created_at || 0) > Number(bestEvent.created_at || 0)) bestEvent = message[2];
      }
      if (message[0] === "EOSE" && message[1] === subId) finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    });
    socket.addEventListener("error", () => finish(null, new Error(`relay failed: ${relayUrl}`)));
  });
}

function parseProfileEvent(event) {
  const profile = JSON.parse(event.content || "{}");
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : null;
}

async function saveSettings() {
  try {
    const payload = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        autopilotTargetId: currentTarget()?.id,
        autopilotLabel: $("autopilotLabelInput").value.trim(),
        autopilotUrl: $("autopilotUrlInput").value.trim(),
        defaultPipeline: $("pipelineInput").value.trim(),
      }),
    });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.settings.currentAutopilotTargetId;
    state.activePipelineName = currentTarget()?.defaultPipeline || payload.settings.defaultPipeline || "";
    localStorage.setItem("chat_wapp_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Settings saved");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadPipelines() {
  try {
    setStatus("Authorizing pipeline list");
    const autopilotTargetId = currentTarget()?.id || state.activeAutopilotTargetId;
    const prepared = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: JSON.stringify({ autopilotTargetId }),
    });
    let payload = prepared;
    if (prepared.requiresAutopilotAuth && prepared.triggerRequest) {
      const autopilotAuthorization = await signNip98Request(prepared.triggerRequest);
      payload = await api("/api/autopilot/pipelines", {
        method: "POST",
        body: JSON.stringify({ autopilotAuthorization, autopilotTargetId }),
      });
    }
    state.pipelines = payload.pipelines || [];
    savePipelinesCache();
    renderPipelineOptions();
    setStatus(`Loaded ${state.pipelines.length} pipelines`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function createAutopilotTarget() {
  try {
    const payload = await api("/api/autopilot-targets", {
      method: "POST",
      body: JSON.stringify({
        label: "New Autopilot",
        url: $("autopilotUrlInput").value.trim() || "http://127.0.0.1:3256",
        defaultPipeline: $("pipelineInput").value.trim() || "chat-wapp-agent-response",
      }),
    });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.target.id;
    state.activePipelineName = payload.target.defaultPipeline;
    localStorage.setItem("chat_wapp_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Autopilot target added");
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteCurrentAutopilotTarget() {
  const target = currentTarget();
  if (!target) return;
  try {
    const payload = await api(`/api/autopilot-targets/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.settings.currentAutopilotTargetId;
    state.activePipelineName = currentTarget()?.defaultPipeline || "";
    localStorage.setItem("chat_wapp_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Autopilot target deleted");
  } catch (error) {
    setStatus(error.message);
  }
}

async function selectAutopilotTarget(targetId) {
  if (!targetId) return;
  state.activeAutopilotTargetId = targetId;
  localStorage.setItem("chat_wapp_autopilot_target", targetId);
  const target = currentTarget();
  state.activePipelineName = target?.defaultPipeline || "";
  localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
  try {
    const payload = await api("/api/autopilot-targets/current", {
      method: "PUT",
      body: JSON.stringify({ autopilotTargetId: targetId }),
    });
    state.settings = payload.settings;
  } catch {
    // Local selection still works for the current browser session.
  }
  renderSettings();
  renderAutopilotTargets();
  renderChatRunControls();
}

async function loadDbStatus() {
  state.dbStatus = await api("/api/db/status");
  renderDbStatus();
}

function renderDbStatus() {
  const meta = $("dbMeta");
  const list = $("snapshotList");
  if (!meta || !list) return;
  const status = state.dbStatus;
  if (!status) {
    meta.textContent = "DB status unavailable.";
    list.innerHTML = "";
    return;
  }
  meta.innerHTML = "";
  const rows = [
    ["Path", status.dbPath],
    ["Size", `${Math.round(Number(status.sizeBytes || 0) / 1024)} KB`],
    ["Migration", status.migrations?.latest || "none"],
    ["Pending import", status.pendingImport ? "yes - restart required" : "no"],
  ];
  for (const [label, value] of rows) {
    const div = document.createElement("div");
    div.innerHTML = `<strong></strong><span></span>`;
    div.querySelector("strong").textContent = label;
    div.querySelector("span").textContent = value;
    meta.appendChild(div);
  }
  list.innerHTML = "";
  for (const snapshot of status.snapshots || []) {
    const item = document.createElement("div");
    item.className = "snapshotItem";
    const info = document.createElement("div");
    info.innerHTML = `<strong></strong><span></span>`;
    info.querySelector("strong").textContent = snapshot.filename;
    info.querySelector("span").textContent = `${snapshot.kind} - ${Math.round(Number(snapshot.sizeBytes || 0) / 1024)} KB`;
    const actions = document.createElement("div");
    actions.className = "snapshotActions";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", () => downloadSnapshot(snapshot.filename));
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Stage";
    restore.addEventListener("click", () => stageSnapshot(snapshot.filename));
    actions.append(download, restore);
    item.append(info, actions);
    list.appendChild(item);
  }
}

async function exportDbSnapshot() {
  try {
    const payload = await api("/api/db/snapshots", {
      method: "POST",
      body: JSON.stringify({ note: $("snapshotNoteInput").value.trim() }),
    });
    state.dbStatus = payload.status;
    $("snapshotNoteInput").value = "";
    renderDbStatus();
    setStatus("Snapshot exported");
  } catch (error) {
    setStatus(error.message);
  }
}

async function stageSnapshot(filename) {
  try {
    const payload = await api("/api/db/import", {
      method: "POST",
      body: JSON.stringify({ filename }),
    });
    state.dbStatus = payload.status;
    renderDbStatus();
    setStatus("Import staged; restart the app to replace the SQLite DB");
  } catch (error) {
    setStatus(error.message);
  }
}

async function downloadSnapshot(filename) {
  try {
    const res = await fetch(`/api/db/snapshots/${encodeURIComponent(filename)}/download`, {
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setStatus(error.message);
  }
}

async function stageUploadedDb() {
  const file = $("importDbInput").files?.[0];
  if (!file) {
    setStatus("Choose a SQLite file first");
    return;
  }
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/db/import", {
      method: "POST",
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
      body: form,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    state.dbStatus = payload.status;
    $("importDbInput").value = "";
    renderDbStatus();
    setStatus("Import staged; restart the app to replace the SQLite DB");
  } catch (error) {
    setStatus(error.message);
  }
}

async function clearPendingImport() {
  try {
    const payload = await api("/api/db/import", { method: "DELETE" });
    state.dbStatus = payload.status;
    renderDbStatus();
    setStatus("Pending import cleared");
  } catch (error) {
    setStatus(error.message);
  }
}

async function addAccess() {
  try {
    const payload = await api("/api/access-rules", {
      method: "POST",
      body: JSON.stringify({
        npub: $("accessNpubInput").value.trim(),
        role: $("accessRoleSelect").value,
      }),
    });
    state.accessRules = payload.accessRules || [];
    $("accessNpubInput").value = "";
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

async function removeAccessRule(rule) {
  try {
    const payload = await api(`/api/access-rules/${encodeURIComponent(rule.role)}/${encodeURIComponent(rule.npub)}`, {
      method: "DELETE",
    });
    state.accessRules = payload.accessRules || [];
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";
  for (const chat of state.chats) {
    const button = document.createElement("button");
    button.className = `chatItem${chat.id === state.activeChatId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = chat.title;
    button.querySelector("span").textContent = chat.preview || "No messages yet";
    button.addEventListener("click", async () => {
      state.activeChatId = chat.id;
      localStorage.setItem("chat_wapp_chat", chat.id);
      renderChats();
      await loadActiveChat();
    });
    list.appendChild(button);
  }
}

async function newChat() {
  const payload = await api("/api/chats", { method: "POST", body: "{}" });
  state.activeChatId = payload.chat.id;
  localStorage.setItem("chat_wapp_chat", state.activeChatId);
  await loadChats();
  await loadActiveChat();
}

async function loadActiveChat() {
  if (!state.activeChatId) return;
  const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`);
  $("chatTitle").textContent = payload.chat.title;
  renderMessages(payload.messages || []);
  renderChats();
}

function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = `message ${message.role} ${message.status}`;
    node.textContent = message.status === "pending" ? "Thinking..." : message.content;
    box.appendChild(node);
  }
  box.scrollTop = box.scrollHeight;
  const pending = messages.some((message) => message.status === "pending");
  setStatus(pending ? "Pipeline running" : "Ready");
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("messageInput");
  const content = input.value.trim();
  if (!content || !state.activeChatId) return;
  input.value = "";
  $("sendButton").disabled = true;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        autopilotTargetId: currentTarget()?.id || state.activeAutopilotTargetId,
        pipelineName: $("chatPipelineSelect").value || state.activePipelineName || currentTarget()?.defaultPipeline,
      }),
    });
    renderMessages(payload.messages || []);
    if (payload.requiresAutopilotAuth && payload.triggerRequest) {
      setStatus("Authorizing pipeline");
      const autopilotAuthorization = await signNip98Request(payload.triggerRequest);
      const started = await api(`/api/pipeline-runs/${encodeURIComponent(payload.runId)}/start`, {
        method: "POST",
        body: JSON.stringify({ autopilotAuthorization }),
      });
      renderMessages(started.messages || []);
    }
    await loadChats();
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("sendButton").disabled = false;
    input.focus();
  }
}

async function signNip98Request(triggerRequest) {
  const tags = [
    ["u", triggerRequest.url],
    ["method", triggerRequest.method || "POST"],
  ];
  if (triggerRequest.body !== undefined) {
    const bodyJson = JSON.stringify(triggerRequest.body);
    tags.push(["payload", await sha256Hex(bodyJson)]);
  }
  const eventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
  const event = state.directNsec
    ? signEventWithNsec(state.directNsec, eventTemplate)
    : window.nostr
      ? await window.nostr.signEvent(eventTemplate)
      : null;
  if (!event) throw new Error("No Nostr signer available. Sign in with nsec or use a browser extension.");
  return `Nostr ${base64Utf8(JSON.stringify(event))}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (state.route === "/chat" && state.activeChatId && state.token) {
      await loadActiveChat().catch(() => undefined);
      await loadChats().catch(() => undefined);
    }
  }, 1500);
}

$("loginButton").addEventListener("click", login);
$("nsecLoginButton").addEventListener("click", loginWithNsec);
$("nsecInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void loginWithNsec();
  }
});
$("logoutButton").addEventListener("click", logout);
$("newChatButton").addEventListener("click", newChat);
$("homeActButton").addEventListener("click", () => navigate("/act"));
$("homeChatButton").addEventListener("click", () => navigate("/chat"));
$("homeSettingsButton").addEventListener("click", () => navigate("/settings"));
$("settingsHomeButton").addEventListener("click", () => navigate("/"));
$("saveSettingsButton").addEventListener("click", saveSettings);
$("loadPipelinesButton").addEventListener("click", loadPipelines);
$("newTargetButton").addEventListener("click", createAutopilotTarget);
$("deleteTargetButton").addEventListener("click", deleteCurrentAutopilotTarget);
$("addAccessButton").addEventListener("click", addAccess);
$("refreshDbButton").addEventListener("click", loadDbStatus);
$("exportDbButton").addEventListener("click", exportDbSnapshot);
$("importDbButton").addEventListener("click", stageUploadedDb);
$("clearImportButton").addEventListener("click", clearPendingImport);
$("autopilotTargetSelect").addEventListener("change", (event) => {
  void selectAutopilotTarget(event.target.value);
});
$("chatAutopilotSelect").addEventListener("change", (event) => {
  void selectAutopilotTarget(event.target.value);
});
$("pipelineSelect").addEventListener("change", () => {
  if ($("pipelineSelect").value) $("pipelineInput").value = $("pipelineSelect").value;
});
$("chatPipelineSelect").addEventListener("change", () => {
  state.activePipelineName = $("chatPipelineSelect").value || currentTarget()?.defaultPipeline || "";
  localStorage.setItem("chat_wapp_pipeline", state.activePipelineName);
});
$("composer").addEventListener("submit", sendMessage);
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

window.addEventListener("popstate", () => {
  void renderRoute();
});

if (state.token) bootApp();
else showOnly("login");
