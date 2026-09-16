import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "../.t3-upstream/t3code/packages/contracts/src/index.ts";

import {
  deriveWsBaseUrl,
  loadConfigFromEnv,
  prepareConnection,
  type PreparedT3Connection,
  type T3ConnectionConfig,
} from "./auth.ts";
import { makeCommandId, makeMessageId, makeThreadId, nowIso, sanitizeError } from "./util.ts";

const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = any;
type StreamMethodName = typeof ORCHESTRATION_WS_METHODS.subscribeShell | typeof ORCHESTRATION_WS_METHODS.subscribeThread;

export interface BridgeClientOptions {
  readonly config?: T3ConnectionConfig;
}

export interface StartTurnInput {
  readonly threadId?: string;
  readonly projectId?: string;
  readonly text: string;
  readonly title?: string;
  readonly modelSelection?: unknown;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export class T3BridgeClient {
  readonly #config: T3ConnectionConfig;
  #sessionPromise?: Promise<{
    config: T3ConnectionConfig;
    initial?: PreparedT3Connection;
  }>;

  constructor(options: BridgeClientOptions = {}) {
    this.#config = options.config ?? loadConfigFromEnv();
  }

  get scopes(): readonly AuthEnvironmentScope[] {
    return this.#config.scopes;
  }

  async #prepareConnection(): Promise<PreparedT3Connection> {
    this.#sessionPromise ??= prepareConnection(this.#config).then((initial) => ({
      initial,
      config: {
        ...this.#config,
        httpBaseUrl: initial.httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(initial.httpBaseUrl),
        bearerToken: initial.bearerToken,
        pairingUrl: undefined,
        pairingHost: undefined,
        pairingCode: undefined,
        devAuthToken: undefined,
      },
    }));
    const session = await this.#sessionPromise;
    if (session.initial) {
      const initial = session.initial;
      delete session.initial;
      return initial;
    }
    return prepareConnection(session.config);
  }

  async connectionInfo(): Promise<{ httpBaseUrl: string; label?: string }> {
    const prepared = await this.#prepareConnection();
    return { httpBaseUrl: prepared.httpBaseUrl, label: prepared.label };
  }

  async #withClient<T>(fn: (client: WsRpcClient) => any): Promise<T> {
    const prepared = await this.#prepareConnection();
    const effect = Effect.scoped(
      Effect.gen(function* () {
        const webSocketConstructor = (url: string, protocols?: string | string[]) =>
          new WebSocket(url, protocols);
        if (webSocketConstructor === undefined) {
          return yield* Effect.fail(new Error("This Node.js runtime does not expose global WebSocket."));
        }
        const socketLayer = Socket.layerWebSocket(prepared.wsUrl, { openTimeout: "15 seconds" }).pipe(
          Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
        );
        const protocolLayer = Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
        ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
        const context = yield* Layer.build(protocolLayer);
        const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(context));
        return yield* fn(client);
      }),
    );
    try {
      return await Effect.runPromise(effect as any);
    } catch (error) {
      throw new Error(sanitizeError(error));
    }
  }

  async call(method: string, payload: unknown): Promise<unknown> {
    return this.#withClient((client) => {
      const callable = (client as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown, never>>)[method];
      if (typeof callable !== "function") {
        return Effect.fail(new Error(`Unknown T3 RPC method: ${method}`));
      }
      return callable(payload ?? {});
    });
  }

  async collectStream(method: StreamMethodName, payload: unknown, maxEvents: number): Promise<unknown[]> {
    return this.#withClient((client) => {
      const stream = (client as Record<string, (payload: unknown) => Stream.Stream<unknown, unknown, never>>)[method](payload ?? {});
      return stream.pipe(
        Stream.take(maxEvents),
        Stream.runCollect,
        Effect.map((items) => Array.from(items as Iterable<unknown>)),
      );
    });
  }

  async listProjectsAndThreads(): Promise<unknown> {
    const events = await this.collectStream(ORCHESTRATION_WS_METHODS.subscribeShell, { requestCompletionMarker: true }, 2);
    const snapshot = events.find((event) => typeof event === "object" && event !== null && (event as { kind?: string }).kind === "snapshot");
    return snapshot ?? events;
  }

  async watchShell(afterSequence?: number, maxEvents = 25): Promise<unknown[]> {
    return this.collectStream(
      ORCHESTRATION_WS_METHODS.subscribeShell,
      { ...(afterSequence === undefined ? {} : { afterSequence }), requestCompletionMarker: true },
      maxEvents,
    );
  }

  async getThread(threadId: string, options: { afterSequence?: number; turnLimit?: number; maxEvents?: number } = {}): Promise<unknown[]> {
    return this.collectStream(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      {
        threadId,
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        ...(options.turnLimit === undefined ? {} : { turnLimit: options.turnLimit }),
        requestCompletionMarker: true,
      },
      options.maxEvents ?? 3,
    );
  }

  async createThread(input: {
    projectId: string;
    title: string;
    modelSelection: unknown;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
    branch?: string | null;
    worktreePath?: string | null;
  }): Promise<unknown> {
    const threadId = makeThreadId();
    const createdAt = nowIso();
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: makeCommandId("thread-create"),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt,
    });
  }

  async startTurn(input: StartTurnInput): Promise<unknown> {
    const threadId = input.threadId ?? makeThreadId();
    const createdAt = nowIso();
    const command: Record<string, unknown> = {
      type: "thread.turn.start",
      commandId: makeCommandId("turn-start"),
      threadId,
      message: {
        messageId: makeMessageId(),
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      createdAt,
    };
    if (input.modelSelection !== undefined) command.modelSelection = input.modelSelection;
    if (input.title !== undefined) command.titleSeed = input.title;
    if (input.projectId !== undefined && input.title !== undefined && input.modelSelection !== undefined) {
      command.bootstrap = {
        createThread: {
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          branch: input.branch ?? null,
          worktreePath: input.worktreePath ?? null,
          createdAt,
        },
      };
    }
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<unknown> {
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.interrupt",
      commandId: makeCommandId("turn-interrupt"),
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      createdAt: nowIso(),
    });
  }

  async respondApproval(threadId: string, requestId: string, decision: ProviderApprovalDecision): Promise<unknown> {
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.approval.respond",
      commandId: makeCommandId("approval-respond"),
      threadId,
      requestId,
      decision,
      createdAt: nowIso(),
    });
  }

  async respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<unknown> {
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.user-input.respond",
      commandId: makeCommandId("user-input-respond"),
      threadId,
      requestId,
      answers,
      createdAt: nowIso(),
    });
  }

  async dismissUserInput(threadId: string, requestId: string): Promise<unknown> {
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.user-input.dismiss",
      commandId: makeCommandId("user-input-dismiss"),
      threadId,
      requestId,
      createdAt: nowIso(),
    });
  }

  async stopProviderSession(threadId: string, onlyIfSettled?: boolean): Promise<unknown> {
    return this.call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.session.stop",
      commandId: makeCommandId("session-stop"),
      threadId,
      ...(onlyIfSettled === undefined ? {} : { onlyIfSettled }),
      createdAt: nowIso(),
    });
  }

  async getServerConfig(): Promise<unknown> {
    return this.call(WS_METHODS.serverGetConfig, {});
  }
}
