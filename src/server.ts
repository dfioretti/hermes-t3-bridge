#!/usr/bin/env tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { T3BridgeClient } from "./t3BridgeClient.ts";
import { sanitizeError, toJsonText } from "./util.ts";

const client = new T3BridgeClient();
const server = new McpServer({ name: "hermes-t3-bridge", version: "0.1.0" });

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: toJsonText(value) }] };
}

function toolError(error: unknown) {
  return { content: [{ type: "text" as const, text: sanitizeError(error) }], isError: true };
}

function registerTool<Input extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Input,
  handler: (input: z.objectOutputType<Input, z.ZodTypeAny>) => Promise<unknown>,
): void {
  (server as any).tool(name, description, inputSchema, async (input: any) => {
    try {
      return jsonContent(await handler(input));
    } catch (error) {
      return toolError(error);
    }
  });
}

registerTool(
  "connection_info",
  "READ-ONLY: Resolve the configured T3 environment and report non-secret connection metadata. Does not print bearer tokens, pairing tokens, or WebSocket tickets.",
  {},
  async () => client.connectionInfo(),
);

registerTool(
  "list_projects_threads",
  "READ-ONLY: Subscribe to T3 orchestration.subscribeShell and return the current projects/threads shell snapshot.",
  {},
  async () => client.listProjectsAndThreads(),
);

registerTool(
  "get_thread_state",
  "READ-ONLY: Subscribe to T3 orchestration.subscribeThread and return the thread snapshot plus initial synchronization marker/events.",
  {
    threadId: z.string().min(1),
    turnLimit: z.number().int().positive().optional(),
    maxEvents: z.number().int().positive().max(100).default(3),
  },
  async ({ threadId, turnLimit, maxEvents }) => client.getThread(threadId, { turnLimit, maxEvents }),
);

registerTool(
  "watch_thread_updates",
  "READ-ONLY: Poll/watch T3 thread updates by collecting a bounded number of orchestration.subscribeThread stream items. Use afterSequence to resume from a known sequence.",
  {
    threadId: z.string().min(1),
    afterSequence: z.number().int().nonnegative().optional(),
    maxEvents: z.number().int().positive().max(100).default(25),
  },
  async ({ threadId, afterSequence, maxEvents }) => client.getThread(threadId, { afterSequence, maxEvents }),
);

registerTool(
  "watch_shell_updates",
  "READ-ONLY: Poll/watch project/thread list updates by collecting a bounded number of orchestration.subscribeShell stream items. Use afterSequence to resume from a known sequence.",
  {
    afterSequence: z.number().int().nonnegative().optional(),
    maxEvents: z.number().int().positive().max(100).default(25),
  },
  async ({ afterSequence, maxEvents }) => client.watchShell(afterSequence, maxEvents),
);

const modelSelectionSchema = z.any().describe("T3 ModelSelection object from @t3tools/contracts; pass through from server config or an existing thread.");
const runtimeModeSchema = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).default("full-access");
const interactionModeSchema = z.enum(["default", "plan"]).default("default");

registerTool(
  "create_thread",
  "MUTATING: Dispatch thread.create through T3 orchestration.dispatchCommand. Creates a thread in the selected T3 project; does not write SQLite directly.",
  {
    projectId: z.string().min(1),
    title: z.string().min(1),
    modelSelection: modelSelectionSchema,
    runtimeMode: runtimeModeSchema,
    interactionMode: interactionModeSchema,
    branch: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
  },
  async (input) => client.createThread(input as Parameters<typeof client.createThread>[0]),
);

registerTool(
  "send_message_start_turn",
  "MUTATING: Dispatch thread.turn.start through T3 orchestration.dispatchCommand. Sends a user message and starts a provider turn. If threadId is omitted, projectId/title/modelSelection are required and T3 bootstraps a new thread.",
  {
    threadId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    modelSelection: modelSelectionSchema.optional(),
    text: z.string().min(1),
    runtimeMode: runtimeModeSchema,
    interactionMode: interactionModeSchema,
    branch: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
  },
  async (input) => {
    if (!input.threadId && !(input.projectId && input.title && input.modelSelection !== undefined)) {
      throw new Error("When threadId is omitted, projectId, title, and modelSelection are required for T3 bootstrap.createThread.");
    }
    return client.startTurn(input);
  },
);

registerTool(
  "interrupt_turn",
  "MUTATING: Dispatch thread.turn.interrupt through T3 orchestration.dispatchCommand to request interruption of the current/running turn.",
  { threadId: z.string().min(1), turnId: z.string().min(1).optional() },
  async ({ threadId, turnId }) => client.interruptTurn(threadId, turnId),
);

registerTool(
  "respond_approval_request",
  "MUTATING: Dispatch thread.approval.respond through T3 orchestration.dispatchCommand for a pending approval request.",
  {
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
  },
  async ({ threadId, requestId, decision }) => client.respondApproval(threadId, requestId, decision),
);

registerTool(
  "respond_user_input_request",
  "MUTATING: Dispatch thread.user-input.respond through T3 orchestration.dispatchCommand for a pending user-input request.",
  {
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    answers: z.record(z.unknown()),
  },
  async ({ threadId, requestId, answers }) => client.respondUserInput(threadId, requestId, answers),
);

registerTool(
  "dismiss_user_input_request",
  "MUTATING: Dispatch thread.user-input.dismiss through T3 orchestration.dispatchCommand to release an async question without answering it.",
  { threadId: z.string().min(1), requestId: z.string().min(1) },
  async ({ threadId, requestId }) => client.dismissUserInput(threadId, requestId),
);

registerTool(
  "stop_provider_session",
  "MUTATING: Dispatch thread.session.stop through T3 orchestration.dispatchCommand to stop the provider session for a thread. This does not kill OS processes by pattern.",
  { threadId: z.string().min(1), onlyIfSettled: z.boolean().optional() },
  async ({ threadId, onlyIfSettled }) => client.stopProviderSession(threadId, onlyIfSettled),
);

registerTool(
  "raw_t3_rpc_call",
  "ADVANCED MUTATING/READ-ONLY: Call a named T3 WS RPC method from @t3tools/contracts with a raw JSON payload. Prefer the explicit tools above; use this only for contract-covered methods not yet wrapped.",
  { method: z.string().min(1), payload: z.unknown().default({}) },
  async ({ method, payload }) => client.call(method, payload),
);

await server.connect(new StdioServerTransport());
