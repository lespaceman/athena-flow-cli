# Plan: Athena Console Channel Adapter

## Goal

Add a new built-in `console` channel adapter so any rich client can become a live Athena conversational surface for a paired remote CLI runtime.

The rich client does not connect directly to the CLI gateway. It connects to a broker service. The broker service bridges authenticated client sockets to the CLI gateway adapter over an authenticated outbound WSS connection from the remote instance.

The dashboard Worker is the first expected broker implementation, but the adapter is not dashboard-specific. A browser, mobile app, desktop app, or partner-hosted UI can all use the same `athena-console` protocol through a compatible broker.

End state:

- A rich client has a `Console` surface.
- User messages become standard `NormalizedInbound` messages.
- Runtime replies flow back as standard adapter outbound messages.
- Permission and question prompts reuse the existing relay coordinator.
- No new dispatcher, runtime, or SessionBridge protocol is invented.

## Naming Decision

Use `console` for the adapter name.

Rejected names:

- `web-ui`: too browser-specific.
- `dashboard`: too product-specific.
- `client`: too ambiguous inside this codebase because there are already control clients and transport clients.
- `rich-client`: descriptive but awkward as a stable adapter id and source path.

Recommended naming:

- Adapter module: `console`
- Source path: `src/gateway/adapters/console/`
- Channel id in normalized locations: `console`
- Protocol namespace: `athena-console`
- Product surface label: `Console`
- First broker implementation: dashboard Worker

## Architecture

```text
Browser, mobile app, desktop app, or hosted UI
  |
  | product/session auth
  v
Rich-client broker service
  |
  | paired runner JWT or broker token, WSS
  v
CLI gateway console adapter
  |
  | ChannelAdapter interface
  v
ChannelManager -> Dispatcher -> SessionRegistry -> SessionBridge -> Runtime
  ^
  |
RelayCoordinator for permission/question prompts
```

The console adapter is just another `ChannelAdapter`, similar to Telegram. The broker service is the provider transport for that adapter. The dashboard Worker is only the first broker.

## Non-Goals

- Do not make rich-client sockets speak the CLI ControlEnvelope protocol.
- Do not add direct client-to-runner connectivity.
- Do not change dispatcher or runtime semantics.
- Do not implement full multi-tenancy inside the CLI gateway in this slice.
- Do not persist console relay prompts across gateway daemon restart.
- Do not make dashboard-specific branches in CLI gateway code.

## Protocol Shape

Use shared `athena-console` frame types from the cleanup plan. If the cleanup plan has not landed yet, add the shared type file as the first task in this plan.

Minimum adapter-to-broker frames:

- `hello`: adapter authenticates and announces runner/workspace metadata.
- `ready`: broker accepts the adapter connection.
- `inbound.message`: rich-client user message routed from broker to adapter.
- `outbound.message`: runtime reply routed from adapter to broker.
- `permission.request`: adapter asks broker to show a permission prompt.
- `permission.response`: broker returns user decision.
- `question.request`: adapter asks broker to show a question prompt.
- `question.response`: broker returns answers.
- `cancel`: either side cancels a pending prompt.
- `ack`: optional delivery acknowledgement for observability.
- `error`: protocol or authorization failure.

Security rules:

- Pairing token/JWT must be in the first frame or Authorization header, never in the URL query string.
- Do not log tokens or raw Authorization headers.
- Broker must bind the adapter socket to one runner identity.
- Rich-client socket auth remains the broker/product's responsibility.

## CLI Implementation Tasks

### A1. Add console adapter module skeleton

Create:

- `src/gateway/adapters/console/index.ts`
- `src/gateway/adapters/console/module.ts`
- `src/gateway/adapters/console/adapter.ts`
- `src/gateway/adapters/console/client.ts`
- `src/gateway/adapters/console/types.ts`

Register the module in `src/gateway/adapters/registry.ts` by adding one line to `BUILTIN_MODULES`.

Config options:

- `brokerUrl`: WSS endpoint for the broker adapter socket.
- `runnerId`: broker-visible runner id.
- `workspaceId`: optional workspace/org/account id.
- `pairingToken`: inline token for tests and local dev only.
- `tokenPath`: preferred production token source.
- `tlsCaPath`: optional CA bundle for self-signed dev deployments.

Validation:

- Require `brokerUrl`, `runnerId`, and either `pairingToken` or `tokenPath`.
- Require `wss://` outside explicit local development.
- Reject missing `tokenPath` files with a clear adapter config error.
- Redact token values in all errors and traces.

### A2. Implement broker client

In `src/gateway/adapters/console/client.ts`, implement a small client wrapper around WebSocket:

- connect with auth
- send `hello`
- wait for `ready`
- emit typed frames to the adapter
- reconnect with bounded backoff
- expose `sendFrame(frame)`
- expose `close(reason)`

Keep this client adapter-local. It is not the existing gateway control client.

Tests:

- ready handshake succeeds
- unauthorized/error frame rejects startup
- close before ready rejects startup
- token is redacted from thrown errors

### A3. Implement inbound chat normalization

In `adapter.ts`, convert console `inbound.message` frames into `NormalizedInbound`.

Suggested mapping:

```ts
{
  location: {
    channelId: "console",
    accountId: workspaceId,
    roomId: runnerId,
    threadId: frame.threadId ?? frame.conversationId,
    peer: { kind: "user", id: frame.userId },
  },
  sender: {
    id: frame.userId,
    displayName: frame.displayName,
  },
  text: frame.text,
  receivedAt: frame.sentAt,
  providerMessageId: frame.messageId,
  idempotencyKey: `console:${runnerId}:${frame.messageId}`,
}
```

Use existing `AdapterContext.emitInbound` instead of a custom dispatcher path.

Tests:

- a console user message emits exactly one `NormalizedInbound`
- duplicate provider message ids are deduped by existing gateway path
- thread/conversation ids map deterministically to the session key ladder

### A4. Implement outbound runtime replies

Implement `send(message: OutboundMessage): Promise<SendResult>`.

The adapter should send `outbound.message` to the broker with:

- runner id
- conversation/thread id
- text body
- idempotency key
- optional reply metadata if present in `OutboundMessage`

Return a normal `SendResult` using the broker ack/provider id when available.

Tests:

- `send` emits the correct frame
- broker ack returns a provider message id
- broker error parks via existing outbound outbox behavior

### A5. Implement permission relay support

Implement `requestPermissionVerdict(req, signal)`.

Behavior:

- Send `permission.request` with `channelRequestId`.
- Store a pending resolver keyed by `channelRequestId`.
- Resolve when `permission.response` arrives.
- On abort or timeout, send cancel if the socket is open and resolve as cancelled.
- Ignore late responses after settlement.

Tests:

- allow/deny verdict resolves correctly
- abort resolves cancelled and sends cancel
- late response after cancel is ignored
- reconnect does not duplicate a still-pending prompt without an explicit broker replay

### A6. Implement question relay support

Implement `requestQuestionAnswer(req, signal)` with the same pending-resolution model as permissions.

Tests:

- answers resolve correctly
- cancel resolves cancelled
- malformed answers return a protocol error frame or cancelled result according to existing relay conventions

### A7. Adapter health and lifecycle

Implement:

- `start(ctx)`
- `stop(reason)`
- `probe()`
- health samples through `AdapterContext.emitHealth` if the adapter contract uses it in current code

Expected health states:

- healthy: connected and broker ready
- degraded: reconnecting
- unhealthy: auth rejected or config invalid

Tests:

- `probe()` reports connected state
- `stop()` closes socket and rejects pending relays as cancelled
- reconnect state does not emit duplicate inbound messages

### A8. First broker implementation plan: dashboard Worker

This is for the dashboard repo, not the CLI repo, but the CLI adapter depends on it for the first product integration.

Worker routes:

- `GET /api/runners/:runnerId/console/adapter` upgrades the paired CLI adapter WSS.
- `GET /api/runners/:runnerId/console/ws` upgrades browser/mobile console sockets.

Auth:

- Adapter route uses existing instance-pairing JWT flow.
- Browser/mobile route uses dashboard user session auth.
- Worker verifies the user has access to the runner/workspace before joining the console room.

Routing:

- One active adapter socket per runner for v1.
- Many browser/mobile sockets can subscribe to the runner console.
- Browser/mobile messages are forwarded to the adapter as `inbound.message`.
- Adapter replies are broadcast to subscribed browser/mobile sockets.
- Permission/question frames become modal events in browser/mobile clients.

Persistence:

- At minimum, persist console messages in dashboard storage so refreshes show recent conversation state.
- CLI gateway remains source of runtime dispatch, not the source of dashboard chat history.

### A9. First UI implementation plan: dashboard Console tab

Add a `Console` tab to the runner detail page.

UI components:

- conversation transcript
- composer
- connection status indicator
- permission modal
- question modal
- empty state for no paired runner
- reconnecting state
- error state for permission denied or runner offline

Behavior:

- send message over the dashboard console socket
- render assistant replies from broker frames
- render permission/question prompts as blocking modals
- handle duplicate frames idempotently by message id / channel request id

### A10. Documentation and sample config

Update `docs/guides/remote-gateway.md` or add `docs/guides/athena-console-channel.md`.

Include sample sidecar config:

```json
{
	"name": "console",
	"enabled": true,
	"options": {
		"brokerUrl": "wss://dashboard.example.com/api/runners/runner_123/console/adapter",
		"runnerId": "runner_123",
		"workspaceId": "workspace_123",
		"tokenPath": "~/.config/athena/console/pairing.jwt"
	}
}
```

Document:

- pairing flow
- local development setup
- security model
- failure modes
- how to smoke test with the first broker implementation

## CLI Test Plan

Focused tests during implementation:

```bash
npm test -- src/gateway/adapters/console
npm test -- src/gateway/channelManager.test.ts src/gateway/relay/coordinator.test.ts
npm run typecheck
```

Full gates before completion:

```bash
npm run typecheck
npm run lint:eslint
npm run lint:dead
npm test
npm run build
```

## Smoke Test Plan

Local fake broker:

1. Start a tiny local WSS/WS test broker that accepts the adapter route.
2. Configure the console sidecar with the local broker URL.
3. Start the gateway daemon with channels enabled.
4. Send `inbound.message` from the fake broker.
5. Confirm `gateway status --json` shows the console adapter healthy.
6. Confirm the runtime receives a turn.
7. Confirm `outbound.message` is sent back to the fake broker.
8. Trigger a permission prompt and confirm `permission.request` / `permission.response` complete.

Real dashboard broker:

1. Pair a runner.
2. Open runner detail page.
3. Open Console tab.
4. Send a prompt.
5. Confirm assistant response appears.
6. Trigger a permission request.
7. Approve/deny from the modal.
8. Confirm the runtime continues with the selected verdict.

## Completion Criteria

- `console` is a built-in adapter module.
- Console inbound messages dispatch through `ChannelManager` as `NormalizedInbound`.
- Runtime replies flow back through `adapter.send`.
- Permission and question prompts round-trip through existing `RelayCoordinator`.
- Token handling is redacted and does not use URL query strings.
- CLI gates pass.
- First broker and UI integration have a documented compatible protocol and smoke path.

## Risks And Watchpoints

- Do not let broker frames leak into the CLI ControlEnvelope protocol.
- Do not add console-specific branches to the dispatcher or runtime.
- Do not assume only browsers exist. Keep frame names client-neutral.
- Do not rely on in-memory broker chat state only; refresh and reconnect need message history from broker storage.
- Multi-tenancy remains a broker/gateway routing concern for a later plan. For v1, bind one adapter socket to one runner identity and reject ambiguous ownership.
