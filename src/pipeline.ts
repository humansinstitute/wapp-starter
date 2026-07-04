import { ALLOW_MOCK, HTTP_TRIGGER_TOKEN, PIPELINE_NAME, WEBHOOK_SECRET, WINGMAN_URL } from "./config.ts";
import type { Message } from "./db.ts";

export type PipelineStartInput = {
  chatId: string;
  userPubkey: string;
  userNpub: string;
  message: string;
  history: Array<Pick<Message, "role" | "content" | "createdAt">>;
  webhookUrl: string;
  webhookToken: string;
  autopilotTargetId?: string;
  autopilotLabel?: string;
  autopilotUrl?: string;
  pipelineName?: string;
};

export type PipelineStartResult = {
  mode: "autopilot-http" | "mock";
  runId: string;
  status: "running" | "mocked";
};

export type PipelineTriggerRequest = {
  url: string;
  method: "POST";
  body: {
    input: {
      source: "chat-wapp";
      chatId: string;
      autopilotTargetId?: string;
      autopilotLabel?: string;
      pipelineName: string;
      userPubkey: string;
      userNpub: string;
      message: string;
      history: Array<Pick<Message, "role" | "content" | "createdAt">>;
      webhook: {
        url: string;
        token: string;
        authHeader: "x-chat-wapp-token";
      };
    };
  };
};

export function buildPipelineTriggerRequest(input: PipelineStartInput): PipelineTriggerRequest {
  const autopilotUrl = (input.autopilotUrl || WINGMAN_URL).replace(/\/$/, "");
  const pipelineName = input.pipelineName || PIPELINE_NAME;
  const url = new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineName)}`, autopilotUrl);
  return {
    url: url.toString(),
    method: "POST",
    body: {
      input: {
        source: "chat-wapp",
        chatId: input.chatId,
        autopilotTargetId: input.autopilotTargetId,
        autopilotLabel: input.autopilotLabel,
        pipelineName,
        userPubkey: input.userPubkey,
        userNpub: input.userNpub,
        message: input.message,
        history: input.history,
        webhook: {
          url: input.webhookUrl,
          token: input.webhookToken,
          authHeader: "x-chat-wapp-token",
        },
      },
    },
  };
}

export async function startChatPipeline(input: PipelineStartInput, authorization?: string): Promise<PipelineStartResult> {
  return startPreparedChatPipeline(buildPipelineTriggerRequest(input), authorization);
}

export async function startPreparedChatPipeline(trigger: PipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  const input = trigger.body.input;
  try {
    return await startAutopilotHttpPipeline(trigger, authorization);
  } catch (error) {
    if (!ALLOW_MOCK) throw error;
    return startMockPipeline({
      chatId: input.chatId,
      userPubkey: input.userPubkey,
      userNpub: input.userNpub,
      message: input.message,
      history: input.history,
      webhookUrl: input.webhook.url,
      webhookToken: input.webhook.token,
    }, error);
  }
}

async function startAutopilotHttpPipeline(trigger: PipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  const res = await fetch(trigger.url, {
    method: trigger.method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : HTTP_TRIGGER_TOKEN ? { authorization: `Bearer ${HTTP_TRIGGER_TOKEN}` } : {}),
    },
    body: JSON.stringify(trigger.body),
  });
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof payload.error === "string" ? payload.error : res.statusText;
    throw new Error(`Autopilot trigger failed (${res.status}): ${detail}`);
  }
  const run = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : {};
  return {
    mode: "autopilot-http",
    runId: String(run.id ?? payload.runId ?? crypto.randomUUID()),
    status: "running",
  };
}

function startMockPipeline(input: PipelineStartInput, cause: unknown): PipelineStartResult {
  const runId = `mock-${crypto.randomUUID()}`;
  const reason = cause instanceof Error ? cause.message : String(cause);
  setTimeout(async () => {
    const content = [
      `Mock pipeline response for: ${input.message}`,
      "",
      "The WApp stored the chat locally, created a pending assistant message, and delivered this through the same webhook the real pipeline agent will call.",
      `Autopilot trigger fallback reason: ${reason}`,
    ].join("\n");
    await fetch(input.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-wapp-token": input.webhookToken,
        "x-chat-wapp-signature": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        chatId: input.chatId,
        runId,
        status: "ok",
        response: content,
        metadata: { mode: "mock", fallbackReason: reason },
      }),
    }).catch(() => undefined);
  }, 900);
  return { mode: "mock", runId, status: "mocked" };
}
