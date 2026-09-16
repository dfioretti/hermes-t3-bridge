import { randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeCommandId(prefix = "mcp"): string {
  return `${prefix}:command:${randomUUID()}`;
}

export function makeThreadId(): string {
  return `thread:${randomUUID()}`;
}

export function makeMessageId(): string {
  return `message:${randomUUID()}`;
}

export function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(wsTicket=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(token=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(subject_token=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(access_token["'=:\s]+)[^"'\s,}]+/gi, "$1[REDACTED]");
}

export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
