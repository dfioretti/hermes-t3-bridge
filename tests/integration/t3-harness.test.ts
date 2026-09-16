import { describe, expect, it } from "vitest";

import { T3BridgeClient } from "../../src/t3BridgeClient.ts";

describe("T3 integration harness", () => {
  it.skipIf(!process.env.T3_INTEGRATION)(
    "connects to an isolated T3 dev instance and reads the shell snapshot",
    async () => {
      const client = new T3BridgeClient();
      const info = await client.connectionInfo();
      expect(info.httpBaseUrl).toBeTruthy();
      const shell = await client.listProjectsAndThreads();
      expect(shell).toBeTruthy();
    },
    60_000,
  );
});
