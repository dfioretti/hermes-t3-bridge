import { describe, expect, it } from "vitest";

import { deriveWsBaseUrl, loadConfigFromEnv } from "../../src/auth.ts";
import { makeCommandId, makeMessageId, makeThreadId, sanitizeError } from "../../src/util.ts";

describe("auth/config helpers", () => {
  it("derives websocket base URLs from HTTP(S) bases", () => {
    expect(deriveWsBaseUrl("http://127.0.0.1:3773/foo?x=1")).toBe("ws://127.0.0.1:3773/");
    expect(deriveWsBaseUrl("https://example.test/t3")).toBe("wss://example.test/");
  });

  it("loads non-secret environment configuration without requiring live T3 state", () => {
    const config = loadConfigFromEnv({
      T3_HTTP_BASE_URL: "http://localhost:4777/",
      T3_CLIENT_LABEL: "Test bridge",
      T3_REQUEST_TIMEOUT_MS: "1234",
    });
    expect(config.httpBaseUrl).toBe("http://localhost:4777/");
    expect(config.wsBaseUrl).toBe("ws://localhost:4777/");
    expect(config.clientLabel).toBe("Test bridge");
    expect(config.timeoutMs).toBe(1234);
    expect(config.scopes).toContain("orchestration:read");
    expect(config.scopes).toContain("orchestration:operate");
  });
});

describe("utility helpers", () => {
  it("creates non-empty T3-compatible identifier strings", () => {
    expect(makeCommandId()).toMatch(/^mcp:command:/);
    expect(makeThreadId()).toMatch(/^thread:/);
    expect(makeMessageId()).toMatch(/^message:/);
  });

  it("redacts token-like values from errors", () => {
    const sanitized = sanitizeError(
      new Error("Bearer abc.def ws://x/ws?wsTicket=secret&token=pair subject_token=boot access_token: live"),
    );
    expect(sanitized).not.toContain("abc.def");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("pair");
    expect(sanitized).not.toContain("boot");
  });
});
