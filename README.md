# Hermes T3 Bridge

A standalone local MCP server that lets Hermes control T3 Code through T3's authenticated Effect RPC WebSocket (`/ws`). It does not read or write T3 SQLite databases.

## Upstream contract pin

The bridge uses T3's own contracts at:

- repository: `https://github.com/pingdotgg/t3code`
- commit: `e8ca3a82806dff84438d5aba66b693468f7ca426`
- package version observed at that commit: `@t3tools/contracts` `0.0.42`

`npm install` runs `scripts/sync-t3-upstream.mjs`, which checks out that commit under `.t3-upstream/t3code` (gitignored). The bridge imports `WsRpcGroup`, `WS_METHODS`, `ORCHESTRATION_WS_METHODS`, auth scope constants, and ID/command schemas from that checkout instead of inventing a wire protocol.

## Authentication

Use one of these supported T3 mechanisms. Tokens are used only in memory and are redacted from error messages.

### Pairing URL

Set:

    export T3_PAIRING_URL='https://.../pair#token=...'

or:

    export T3_PAIRING_HOST='http://127.0.0.1:3773/'
    export T3_PAIRING_CODE='...'

The bridge exchanges the one-time bootstrap credential at `/oauth/token` for a bearer access token, then exchanges that bearer token for a short-lived `/ws` ticket at `/api/auth/websocket-ticket`.

### Existing bearer token

Set:

    export T3_HTTP_BASE_URL='http://127.0.0.1:3773/'
    export T3_BEARER_TOKEN='...'

The bridge uses the bearer token only to obtain a short-lived WebSocket ticket.

### Isolated dev credential

For an isolated T3 dev server configured with `T3CODE_DEV_AUTH_TOKEN`, set:

    export T3_HTTP_BASE_URL='http://127.0.0.1:<isolated-port>/'
    export T3CODE_DEV_AUTH_TOKEN='...'

Do not point this bridge at live `~/.t3/userdata` during tests.

## Running as an MCP server

Install and start locally:

    npm install
    npm run typecheck
    npm test
    npm start

For a local T3 installation, `scripts/start-live.sh` calls `t3 pair` at process
startup, captures the one-time pairing URL without printing it, and starts the
MCP server. This avoids storing a T3 token in source or Hermes configuration.

Hermes config used by this installation:

    mcp_servers:
      t3:
        command: "/home/devops/repos/hermes-t3-bridge/scripts/start-live.sh"
        args: []
        timeout: 180
        connect_timeout: 60

The wrapper defaults to `${HOME}/.t3`; set `T3CODE_HOME` only when targeting a
different, isolated T3 home. It never reads or writes T3's SQLite files.

## Tools

Read-only tools:

- `connection_info` — resolves non-secret T3 environment metadata.
- `list_projects_threads` — returns the `orchestration.subscribeShell` snapshot.
- `get_thread_state` — returns a bounded `orchestration.subscribeThread` snapshot stream.
- `watch_thread_updates` — bounded poll/watch of thread stream items.
- `watch_shell_updates` — bounded poll/watch of project/thread shell stream items.

Mutating tools:

- `create_thread` — dispatches `thread.create`.
- `send_message_start_turn` — dispatches `thread.turn.start`; can bootstrap a new thread when `projectId`, `title`, and `modelSelection` are provided.
- `interrupt_turn` — dispatches `thread.turn.interrupt`.
- `respond_approval_request` — dispatches `thread.approval.respond`.
- `respond_user_input_request` — dispatches `thread.user-input.respond`.
- `dismiss_user_input_request` — dispatches `thread.user-input.dismiss`.
- `stop_provider_session` — dispatches `thread.session.stop`; it does not kill OS processes by pattern.
- `raw_t3_rpc_call` — escape hatch for named contract RPC methods; prefer explicit tools.

## Integration harness against isolated T3

1. Prepare an isolated T3 development checkout/worktree. Do not use live `~/.t3/userdata`.
2. If you need realistic data, copy into the isolated worktree using T3's documented `VACUUM INTO` flow so the source DB is read consistently.
3. Start the isolated T3 server and capture its port and pairing URL or dev token.
4. Run:

       T3_INTEGRATION=1 \
       T3_PAIRING_URL='https://.../pair#token=...' \
       npm run test:integration

The harness only reads connection metadata and the shell snapshot. It does not create threads, start turns, stop sessions, or kill provider processes.
