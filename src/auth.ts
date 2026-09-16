import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type AuthEnvironmentScope,
} from "../.t3-upstream/t3code/packages/contracts/src/index.ts";
import { sanitizeError } from "./util.ts";

export interface T3ConnectionConfig {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken?: string;
  readonly pairingUrl?: string;
  readonly pairingHost?: string;
  readonly pairingCode?: string;
  readonly devAuthToken?: string;
  readonly clientLabel: string;
  readonly timeoutMs: number;
  readonly scopes: readonly AuthEnvironmentScope[];
}

export interface PreparedT3Connection {
  readonly httpBaseUrl: string;
  readonly wsUrl: string;
  readonly label?: string;
  /** Kept in memory so a one-time pairing credential is never exchanged twice. */
  readonly bearerToken?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function resolvePairingTarget(input: { pairingUrl?: string; host?: string; pairingCode?: string }) {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl) {
    const url = new URL(pairingUrl);
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const credential = hashParams.get("token")?.trim() || url.searchParams.get("token")?.trim();
    if (!credential) throw new Error("Pairing URL is missing its token.");
    const hostedHost = url.searchParams.get("host")?.trim();
    const base = hostedHost ? normalizeRemoteBaseUrl(hostedHost) : url;
    return { credential, httpBaseUrl: toHttpBaseUrl(base), wsBaseUrl: toWsBaseUrl(base) };
  }
  const host = input.host?.trim();
  const credential = input.pairingCode?.trim();
  if (!host) throw new Error("T3 pairing host is required when T3_PAIRING_URL is not set.");
  if (!credential) throw new Error("T3 pairing code is required when T3_PAIRING_URL is not set.");
  const base = normalizeRemoteBaseUrl(host);
  return { credential, httpBaseUrl: toHttpBaseUrl(base), wsBaseUrl: toWsBaseUrl(base) };
}

function normalizeRemoteBaseUrl(rawValue: string): URL {
  const trimmed = rawValue.trim().replace(/^\/+/, "");
  const normalized = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(normalized);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`Unsupported T3 pairing host protocol: ${url.protocol}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function toHttpBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") next.protocol = "http:";
  if (next.protocol === "wss:") next.protocol = "https:";
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

function toWsBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "http:") next.protocol = "ws:";
  if (next.protocol === "https:") next.protocol = "wss:";
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): T3ConnectionConfig {
  const httpBaseUrl = env.T3_HTTP_BASE_URL ?? env.T3_BASE_URL ?? "http://127.0.0.1:3773/";
  const wsBaseUrl = env.T3_WS_BASE_URL ?? deriveWsBaseUrl(httpBaseUrl);
  return {
    httpBaseUrl,
    wsBaseUrl,
    bearerToken: env.T3_BEARER_TOKEN,
    pairingUrl: env.T3_PAIRING_URL,
    pairingHost: env.T3_PAIRING_HOST ?? env.T3_HOST,
    pairingCode: env.T3_PAIRING_CODE,
    devAuthToken: env.T3CODE_DEV_AUTH_TOKEN,
    clientLabel: env.T3_CLIENT_LABEL ?? "Hermes T3 MCP bridge",
    timeoutMs: env.T3_REQUEST_TIMEOUT_MS ? Number(env.T3_REQUEST_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    scopes: AuthStandardClientScopes,
  };
}

export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function endpoint(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`T3 HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(sanitizeError(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeBootstrapForBearer(input: {
  httpBaseUrl: string;
  credential: string;
  scopes: readonly AuthEnvironmentScope[];
  clientLabel: string;
  timeoutMs: number;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: input.credential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    scope: input.scopes.join(" "),
    client_label: input.clientLabel,
    client_device_type: "bot",
    client_os: "Linux",
  });
  const result = await fetchJson<{ access_token: string }>(
    endpoint(input.httpBaseUrl, "/oauth/token"),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    input.timeoutMs,
  );
  if (!result.access_token) throw new Error("T3 token exchange did not return an access token.");
  return result.access_token;
}

async function issueWebSocketTicket(input: {
  httpBaseUrl: string;
  bearerToken: string;
  timeoutMs: number;
}): Promise<string> {
  const result = await fetchJson<{ ticket: string }>(
    endpoint(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.bearerToken}` },
    },
    input.timeoutMs,
  );
  if (!result.ticket) throw new Error("T3 websocket-ticket endpoint did not return a ticket.");
  return result.ticket;
}

async function fetchDescriptor(httpBaseUrl: string, timeoutMs: number): Promise<{ label?: string; environmentId?: string }> {
  return fetchJson(endpoint(httpBaseUrl, "/.well-known/t3/environment"), {}, timeoutMs);
}

export async function prepareConnection(config: T3ConnectionConfig): Promise<PreparedT3Connection> {
  let httpBaseUrl = config.httpBaseUrl;
  let wsBaseUrl = config.wsBaseUrl;
  let bearerToken = config.bearerToken;

  if (config.pairingUrl || (config.pairingHost && config.pairingCode)) {
    const target = resolvePairingTarget({
      pairingUrl: config.pairingUrl,
      host: config.pairingHost,
      pairingCode: config.pairingCode,
    });
    httpBaseUrl = target.httpBaseUrl;
    wsBaseUrl = target.wsBaseUrl;
    bearerToken = await exchangeBootstrapForBearer({
      httpBaseUrl,
      credential: target.credential,
      scopes: config.scopes,
      clientLabel: config.clientLabel,
      timeoutMs: config.timeoutMs,
    });
  } else if (!bearerToken && config.devAuthToken) {
    bearerToken = await exchangeBootstrapForBearer({
      httpBaseUrl,
      credential: config.devAuthToken,
      scopes: config.scopes,
      clientLabel: config.clientLabel,
      timeoutMs: config.timeoutMs,
    });
  }

  const descriptor = await fetchDescriptor(httpBaseUrl, config.timeoutMs).catch(() => ({}));
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  if (bearerToken) {
    url.searchParams.set("wsTicket", await issueWebSocketTicket({ httpBaseUrl, bearerToken, timeoutMs: config.timeoutMs }));
  }
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("clientSurface", "cli");
  url.searchParams.set("clientDeviceType", "unknown");
  url.searchParams.set("connectionMethod", "direct");

  return {
    httpBaseUrl,
    wsUrl: url.toString(),
    label: "label" in descriptor ? descriptor.label : undefined,
    bearerToken,
  };
}
