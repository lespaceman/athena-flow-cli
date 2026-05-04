# Console Channel Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `console` channel adapter so any rich client (browser, mobile, desktop, partner UI) can become a live Athena conversational surface for a paired remote runtime by bridging through a broker service.

**Architecture:** The console adapter is a `ChannelAdapter` (peer of `TelegramAdapter`) that opens an outbound WSS to a broker service. The broker brokers between authenticated rich-client sockets and the adapter, speaking the existing `AthenaConsoleFrame` discriminated union from `src/shared/gateway-protocol/athenaConsole.ts`. Inbound rich-client messages enter the gateway via `AdapterContext.emitInbound`; runtime replies and permission/question relays leave via the adapter's `send` and relay methods. No new dispatcher, runtime, or session-bridge protocol — the adapter is just another `ChannelAdapter`.

**Tech Stack:** TypeScript 5.7, ESM, Node 20+, Vitest, `ws` (^8.20.0), tsup. Pattern mirrors `src/gateway/adapters/telegram/`. Shared frame types already live in `src/shared/gateway-protocol/athenaConsole.ts` (boundary cleanup plan shipped).

---

## Naming Decisions (locked)

- Adapter id: `console`
- Source path: `src/gateway/adapters/console/`
- Channel id in `ChannelLocation.channelId`: `console`
- Protocol namespace: `athena-console`
- First broker implementation: dashboard Worker (separate repo — see "Companion work" at the bottom of this plan)

## Non-Goals

- No multi-tenancy inside the CLI gateway. v1 is one adapter socket = one runner identity.
- No persistence of console relay prompts across daemon restart.
- No dashboard-specific branches in CLI gateway code.
- No direct rich-client-to-runner connectivity. Always via broker.
- No console-side ControlEnvelope speakers. Console frames stay in their own namespace.

## File Structure

**New files**

- `src/gateway/adapters/console/index.ts` — barrel
- `src/gateway/adapters/console/module.ts` — `AdapterModule` (config parsing + construction)
- `src/gateway/adapters/console/adapter.ts` — `ChannelAdapter` implementation
- `src/gateway/adapters/console/client.ts` — `ConsoleBrokerClient` WS wrapper
- `src/gateway/adapters/console/types.ts` — `ConsoleAdapterOptions`, internal config types
- `src/gateway/adapters/console/module.test.ts`
- `src/gateway/adapters/console/client.test.ts`
- `src/gateway/adapters/console/adapter.test.ts`
- `docs/guides/athena-console-channel.md` — operator guide

**Files modified**

- `src/shared/gateway-protocol/athenaConsole.ts` — add cancel frame kinds (Task K0)
- `src/shared/gateway-protocol/index.ts` — re-export the new types (Task K0)
- `src/gateway/adapters/registry.ts` — add `consoleModule` to `BUILTIN_MODULES`
- `src/gateway/adapters/registry.test.ts` (if present) — assert `console` resolves

Each task produces a self-contained commit.

---

## Task K0: Add explicit cancel frames to the shared protocol

**Files:**

- Modify: `src/shared/gateway-protocol/athenaConsole.ts`
- Modify: `src/shared/gateway-protocol/index.ts`

**Why this lands first.** The original frame set used `console.error{code: 'cancelled', refFrameId}` to signal cancel. That is a protocol smell: `refFrameId` is meant to reference a per-connection `frameId`, not a `channelRequestId`. Brokers seeing a `console.error` with a non-frame `refFrameId` would either misroute it or be forced to special-case the `cancelled` code. Two dedicated kinds — `console.permission.cancel` and `console.question.cancel` — keep `refFrameId` honest, give brokers a stable verb to dispatch on, and align with the existing `permission.request`/`permission.response` shape.

This task is types-only; no runtime users yet. K5/K6 consume the new frames.

- [ ] **Step 1: Add the new frame kinds**

Edit `src/shared/gateway-protocol/athenaConsole.ts`. Update `AthenaConsoleFrameKind`:

```typescript
export type AthenaConsoleFrameKind =
	| 'console.hello'
	| 'console.ready'
	| 'console.message.in'
	| 'console.message.out'
	| 'console.permission.request'
	| 'console.permission.response'
	| 'console.permission.cancel'
	| 'console.question.request'
	| 'console.question.response'
	| 'console.question.cancel'
	| 'console.ack'
	| 'console.error';
```

Add the two new frame shapes immediately after `AthenaConsolePermissionResponseFrame`:

```typescript
export type AthenaConsolePermissionCancelFrame = AthenaConsoleFrameBase & {
	kind: 'console.permission.cancel';
	channelRequestId: string;
	/** Free-form short reason (e.g. 'resolved_locally', 'shutdown'). */
	reason?: string;
};
```

And immediately after `AthenaConsoleQuestionResponseFrame`:

```typescript
export type AthenaConsoleQuestionCancelFrame = AthenaConsoleFrameBase & {
	kind: 'console.question.cancel';
	channelRequestId: string;
	reason?: string;
};
```

Extend the union:

```typescript
export type AthenaConsoleFrame =
	| AthenaConsoleHelloFrame
	| AthenaConsoleReadyFrame
	| AthenaConsoleInboundMessageFrame
	| AthenaConsoleOutboundMessageFrame
	| AthenaConsolePermissionRequestFrame
	| AthenaConsolePermissionResponseFrame
	| AthenaConsolePermissionCancelFrame
	| AthenaConsoleQuestionRequestFrame
	| AthenaConsoleQuestionResponseFrame
	| AthenaConsoleQuestionCancelFrame
	| AthenaConsoleAckFrame
	| AthenaConsoleErrorFrame;
```

- [ ] **Step 2: Re-export from the shared barrel**

Edit `src/shared/gateway-protocol/index.ts` — extend the existing `from './athenaConsole'` export block to include the two new types:

```typescript
	AthenaConsolePermissionCancelFrame,
	AthenaConsoleQuestionCancelFrame,
```

(Insert each next to the matching response export so the order stays request → response → cancel.)

- [ ] **Step 3: Verify types compile**

Run:

```bash
npm run typecheck
```

Expected: clean. Adding to a discriminated union has no runtime cost; existing exhaustive switches in the codebase don't yet exist for `AthenaConsoleFrame`, so nothing breaks.

- [ ] **Step 4: Commit**

```bash
git add src/shared/gateway-protocol/athenaConsole.ts src/shared/gateway-protocol/index.ts
git commit -m "feat(gateway-protocol): add console cancel frame kinds"
```

---

## Task K1: Console module skeleton + registry registration

**Files:**

- Create: `src/gateway/adapters/console/types.ts`
- Create: `src/gateway/adapters/console/module.ts`
- Create: `src/gateway/adapters/console/index.ts`
- Create: `src/gateway/adapters/console/module.test.ts`
- Modify: `src/gateway/adapters/registry.ts`

The skeleton sets up the adapter shell with `parseConfig` validation but a stub `create()` that throws — adapter logic comes in later tasks. Registry hookup is one line.

- [ ] **Step 1: Write the config parsing tests first**

Create `src/gateway/adapters/console/module.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {consoleModule} from './module';

describe('consoleModule.parseConfig', () => {
	it('accepts a minimal valid sidecar config (inline pairing token)', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'wss://broker.example.com/runner/r1/console/adapter',
				runner_id: 'runner_1',
				pairing_token: 'tok_abc',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.brokerUrl).toBe(
			'wss://broker.example.com/runner/r1/console/adapter',
		);
		expect(result.config.runnerId).toBe('runner_1');
		expect(result.config.pairingToken).toBe('tok_abc');
	});

	it('accepts token_path in place of pairing_token', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'wss://broker.example.com/adapter',
				runner_id: 'runner_1',
				token_path: '/var/lib/athena/pairing.jwt',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(true);
	});

	it('accepts ws://127.0.0.1 for local development', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'ws://127.0.0.1:8787/adapter',
				runner_id: 'runner_1',
				pairing_token: 'tok',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(true);
	});

	it('rejects ws:// for non-loopback hosts', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'ws://broker.example.com/adapter',
				runner_id: 'runner_1',
				pairing_token: 'tok',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/wss/);
	});

	it('rejects missing broker_url', () => {
		const result = consoleModule.parseConfig({
			options: {runner_id: 'r1', pairing_token: 'tok'},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/broker_url/);
	});

	it('rejects missing runner_id', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'wss://broker.example.com/adapter',
				pairing_token: 'tok',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/runner_id/);
	});

	it('rejects missing both pairing_token and token_path', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'wss://broker.example.com/adapter',
				runner_id: 'r1',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/pairing_token|token_path/);
	});

	it('captures optional workspace_id and tls_ca_path', () => {
		const result = consoleModule.parseConfig({
			options: {
				broker_url: 'wss://broker.example.com/adapter',
				runner_id: 'r1',
				workspace_id: 'ws1',
				pairing_token: 'tok',
				tls_ca_path: '/etc/ssl/broker-ca.pem',
			},
			allowedUserIds: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.workspaceId).toBe('ws1');
		expect(result.config.tlsCaPath).toBe('/etc/ssl/broker-ca.pem');
	});

	it('module name is "console"', () => {
		expect(consoleModule.name).toBe('console');
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run src/gateway/adapters/console/module.test.ts
```

Expected: FAIL — module `./module` not found.

- [ ] **Step 3: Create types module**

Write `src/gateway/adapters/console/types.ts`:

```typescript
/**
 * Internal configuration for the console adapter.
 *
 * `parseConfig` produces this shape from sidecar JSON; `ConsoleAdapter`
 * consumes it. `brokerClientFactory` is a test seam — production code goes
 * through the default factory in `client.ts`.
 */

import type {ConsoleBrokerClient} from './client';

export type ConsoleAdapterOptions = {
	/** WSS endpoint for the broker adapter socket. */
	brokerUrl: string;
	/** Broker-visible runner identity for this paired CLI. */
	runnerId: string;
	/** Optional workspace/org/account id surfaced to the broker. */
	workspaceId?: string;
	/** Inline token (tests + local dev). Production uses `tokenPath`. */
	pairingToken?: string;
	/** Filesystem path to the pairing token. Read at start time. */
	tokenPath?: string;
	/** Optional CA bundle for self-signed broker TLS. */
	tlsCaPath?: string;
	/** Override broker-client factory for tests. */
	brokerClientFactory?: ConsoleBrokerClientFactory;
};

export type ConsoleBrokerClientFactory = (input: {
	brokerUrl: string;
	pairingToken: string;
	tlsCaPath?: string;
	log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}) => ConsoleBrokerClient;
```

- [ ] **Step 4: Create the module + barrel + skeleton client placeholder**

Write `src/gateway/adapters/console/module.ts`:

```typescript
/**
 * Console `AdapterModule` — sidecar-config parsing + adapter construction.
 *
 * Sidecar JSON keys are snake_case (matching the rest of the channels
 * config surface); `parseConfig` translates to the camelCase
 * `ConsoleAdapterOptions` shape consumed inside the adapter. Validation is
 * intentionally strict so misconfiguration fails on daemon start, not on
 * first runtime turn.
 */

import type {AdapterModule} from '../../../shared/gateway-protocol';
import {ConsoleAdapter} from './adapter';
import type {ConsoleAdapterOptions} from './types';

export const consoleModule: AdapterModule<ConsoleAdapterOptions> = {
	name: 'console',

	parseConfig({options}) {
		const brokerUrl = options['broker_url'];
		if (typeof brokerUrl !== 'string' || brokerUrl.length === 0) {
			return {ok: false, reason: 'broker_url missing'};
		}
		if (!/^wss?:\/\//.test(brokerUrl)) {
			return {ok: false, reason: 'broker_url must start with ws:// or wss://'};
		}
		if (brokerUrl.startsWith('ws://') && !isLoopbackUrl(brokerUrl)) {
			return {
				ok: false,
				reason: 'broker_url must use wss:// for non-loopback hosts',
			};
		}
		const runnerId = options['runner_id'];
		if (typeof runnerId !== 'string' || runnerId.length === 0) {
			return {ok: false, reason: 'runner_id missing'};
		}
		const pairingToken = options['pairing_token'];
		const tokenPath = options['token_path'];
		if (
			(pairingToken === undefined || pairingToken === '') &&
			(tokenPath === undefined || tokenPath === '')
		) {
			return {
				ok: false,
				reason: 'either pairing_token or token_path is required',
			};
		}
		if (pairingToken !== undefined && typeof pairingToken !== 'string') {
			return {ok: false, reason: 'pairing_token must be a string'};
		}
		if (tokenPath !== undefined && typeof tokenPath !== 'string') {
			return {ok: false, reason: 'token_path must be a string'};
		}
		const workspaceId = options['workspace_id'];
		if (workspaceId !== undefined && typeof workspaceId !== 'string') {
			return {ok: false, reason: 'workspace_id must be a string'};
		}
		const tlsCaPath = options['tls_ca_path'];
		if (tlsCaPath !== undefined && typeof tlsCaPath !== 'string') {
			return {ok: false, reason: 'tls_ca_path must be a string'};
		}

		const config: ConsoleAdapterOptions = {
			brokerUrl,
			runnerId,
			...(workspaceId !== undefined ? {workspaceId} : {}),
			...(pairingToken !== undefined ? {pairingToken} : {}),
			...(tokenPath !== undefined ? {tokenPath} : {}),
			...(tlsCaPath !== undefined ? {tlsCaPath} : {}),
		};
		return {ok: true, config};
	},

	create(config) {
		return new ConsoleAdapter(config);
	},
};

function isLoopbackUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname;
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return false;
	}
}
```

Write `src/gateway/adapters/console/index.ts`:

```typescript
export {ConsoleAdapter} from './adapter';
export {consoleModule} from './module';
export type {ConsoleAdapterOptions} from './types';
```

Write a stub `src/gateway/adapters/console/adapter.ts` (filled in by later tasks):

```typescript
/**
 * Console channel adapter — WIP skeleton. Real implementation lands in
 * tasks K3–K7.
 */

import type {
	AdapterContext,
	ChannelAdapter,
	ChannelCapabilities,
	OutboundMessage,
	PermissionRelayRequest,
	PermissionRelayResult,
	ProbeResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';
import type {ConsoleAdapterOptions} from './types';

export class ConsoleAdapter implements ChannelAdapter {
	readonly id = 'console';
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: true,
		relayPermission: true,
		relayQuestion: true,
	};

	constructor(private readonly opts: ConsoleAdapterOptions) {}

	async start(_ctx: AdapterContext): Promise<void> {
		throw new Error('console adapter: not yet implemented');
	}

	async stop(_reason: StopReason): Promise<void> {
		throw new Error('console adapter: not yet implemented');
	}

	async send(_msg: OutboundMessage): Promise<SendResult> {
		throw new Error('console adapter: not yet implemented');
	}

	async probe(): Promise<ProbeResult> {
		return {ok: false, detail: 'not yet implemented', checkedAt: Date.now()};
	}

	async requestPermissionVerdict(
		_req: PermissionRelayRequest,
		_signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		return {kind: 'no_relay'};
	}

	async requestQuestionAnswer(
		_req: QuestionRelayRequest,
		_signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		return {kind: 'no_relay'};
	}
}
```

- [ ] **Step 5: Run the module tests and verify they pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/module.test.ts
```

Expected: 8 passing.

- [ ] **Step 6: Register the module**

Edit `src/gateway/adapters/registry.ts` — add the import and entry:

```typescript
import type {AdapterModule} from '../../shared/gateway-protocol';
import {consoleModule} from './console/module';
import {telegramModule} from './telegram/module';

export const BUILTIN_MODULES: ReadonlyArray<AdapterModule> = [
	telegramModule,
	consoleModule,
];

export function findAdapterModule(name: string): AdapterModule | undefined {
	return BUILTIN_MODULES.find(m => m.name === name);
}
```

- [ ] **Step 7: Run typecheck + lint**

Run:

```bash
npm run typecheck
npm run lint:eslint
```

Expected: clean. The skeleton compiles, the module is registered, and the stubbed adapter satisfies the `ChannelAdapter` interface.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/adapters/console src/gateway/adapters/registry.ts
git commit -m "feat(console): scaffold console adapter module + registry hookup"
```

---

## Task K2: Implement `ConsoleBrokerClient` (connect + hello/ready)

**Files:**

- Create: `src/gateway/adapters/console/client.ts`
- Create: `src/gateway/adapters/console/client.test.ts`

The broker client wraps a single WSS connection: open → send `console.hello` → receive `console.ready` → emit typed frames. It is adapter-local; the existing `gateway/transport/wsClient.ts` is for the runtime control plane and must NOT be reused here (different protocol, different layer — the console adapter speaks `AthenaConsoleFrame`, not `ControlEnvelope`).

This task delivers connect-handshake-close. Reconnection lives in K7.

- [ ] **Step 1: Write the client tests first (against an in-process WS server)**

Create `src/gateway/adapters/console/client.test.ts`:

```typescript
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WebSocketServer, type WebSocket as ServerWebSocket} from 'ws';
import {createConsoleBrokerClient} from './client';
import type {AthenaConsoleFrame} from '../../../shared/gateway-protocol';

describe('ConsoleBrokerClient', () => {
	let server: WebSocketServer;
	let port: number;
	let serverSockets: ServerWebSocket[] = [];

	beforeEach(async () => {
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		serverSockets = [];
		server.on('connection', ws => {
			serverSockets.push(ws);
		});
	});

	afterEach(async () => {
		for (const ws of serverSockets) ws.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	const url = (): string => `ws://127.0.0.1:${port}/adapter`;

	function makeClient() {
		return createConsoleBrokerClient({
			brokerUrl: url(),
			pairingToken: 'tok-abc',
			log: () => {},
		});
	}

	it('completes hello/ready handshake and surfaces ready address', async () => {
		const client = makeClient();
		const helloFrames: AthenaConsoleFrame[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				const frame = JSON.parse(String(data)) as AthenaConsoleFrame;
				helloFrames.push(frame);
				if (frame.kind === 'console.hello') {
					const ready: AthenaConsoleFrame = {
						kind: 'console.ready',
						frameId: 'ready-1',
						sentAt: Date.now(),
						protocolVersion: 1,
						brokerName: 'fake-broker',
						address: {runnerId: 'r1'},
					};
					ws.send(JSON.stringify(ready));
				}
			});
		});

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: '0.0.0-test',
		});

		expect(helloFrames).toHaveLength(1);
		expect(helloFrames[0].kind).toBe('console.hello');
		expect(client.getReadyAddress()?.runnerId).toBe('r1');
		client.close('done');
	});

	it('sends pairing token via Authorization header (never URL)', async () => {
		const client = makeClient();
		const headerSeen: string[] = [];
		server.once('connection', (ws, req) => {
			const auth = req.headers['authorization'];
			if (typeof auth === 'string') headerSeen.push(auth);
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
			});
		});

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(headerSeen).toEqual(['Bearer tok-abc']);
		client.close('done');
	});

	it('rejects when broker sends console.error during handshake', async () => {
		const client = makeClient();
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.error',
						frameId: 'e',
						sentAt: 0,
						code: 'unauthorized',
						message: 'bad token',
					}),
				);
			});
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/unauthorized/);
	});

	it('rejects when broker closes before sending ready', async () => {
		const client = makeClient();
		server.once('connection', ws => {
			ws.on('message', () => ws.close());
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/closed/);
	});

	it('rejects when broker accepts the socket but never sends ready', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: url(),
			pairingToken: 'tok',
			log: () => {},
			connectTimeoutMs: 80,
		});
		// Server stays connected, swallows the hello, never replies.
		server.once('connection', ws => {
			ws.on('message', () => {});
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/timed out/);
	});

	it('redacts the pairing token from thrown errors', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: 'ws://127.0.0.1:1/adapter', // unreachable
			pairingToken: 'super-secret-token',
			log: () => {},
			connectTimeoutMs: 50,
		});
		try {
			await client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			});
			throw new Error('expected connect to fail');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toContain('super-secret-token');
		}
	});

	it('emits inbound frames to the registered handler', async () => {
		const client = makeClient();
		const received: AthenaConsoleFrame[] = [];
		client.onFrame(frame => received.push(frame));
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
				setTimeout(() => {
					ws.send(
						JSON.stringify({
							kind: 'console.message.in',
							frameId: 'm1',
							sentAt: Date.now(),
							address: {runnerId: 'r1'},
							messageId: 'm1',
							idempotencyKey: 'console:r1:m1',
							text: 'hi',
						}),
					);
				}, 5);
			});
		});

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});

		await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), {
			timeout: 500,
		});
		expect(received[0].kind).toBe('console.message.in');
		client.close('done');
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/client.test.ts
```

Expected: FAIL — module `./client` does not exist (or `createConsoleBrokerClient` not exported).

- [ ] **Step 3: Implement the client**

Write `src/gateway/adapters/console/client.ts`:

```typescript
/**
 * `ConsoleBrokerClient` — adapter-local WS wrapper that owns one outbound
 * connection to the rich-client broker and speaks the `AthenaConsoleFrame`
 * protocol.
 *
 * Scope of this module:
 *   - open one WSS connection (single-shot in K2; reconnect lives in K7);
 *   - perform `console.hello` → `console.ready` handshake;
 *   - emit typed inbound frames to a single registered handler;
 *   - send outbound frames via `sendFrame()`;
 *   - close cleanly on `close(reason)`.
 *
 * Notes:
 *   - Pairing token travels via the `Authorization: Bearer …` header. It is
 *     never appended to the URL query string and never logged.
 *   - This client is independent from `gateway/transport/wsClient.ts`, which
 *     speaks `ControlEnvelope` for the runtime control plane.
 */

import {readFileSync} from 'node:fs';
import {WebSocket} from 'ws';
import type {
	AthenaConsoleFrame,
	AthenaConsoleHelloFrame,
	AthenaConsoleReadyFrame,
} from '../../../shared/gateway-protocol';

export type ConsoleBrokerClientLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type ConsoleBrokerClientOptions = {
	brokerUrl: string;
	pairingToken: string;
	tlsCaPath?: string;
	log: ConsoleBrokerClientLogger;
	connectTimeoutMs?: number;
};

export type ConsoleHelloPayload = {
	runnerId: string;
	clientName: string;
	clientVersion: string;
};

export type ConsoleBrokerClient = {
	connect(hello: ConsoleHelloPayload): Promise<void>;
	close(reason: string): void;
	sendFrame(frame: AthenaConsoleFrame): void;
	onFrame(handler: (frame: AthenaConsoleFrame) => void): void;
	onReady(handler: (address: AthenaConsoleReadyFrame['address']) => void): void;
	onClose(handler: (reason: string) => void): void;
	getReadyAddress(): AthenaConsoleReadyFrame['address'] | null;
	isReady(): boolean;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function createConsoleBrokerClient(
	opts: ConsoleBrokerClientOptions,
): ConsoleBrokerClient {
	let ws: WebSocket | null = null;
	let ready: AthenaConsoleReadyFrame | null = null;
	const frameHandlers = new Set<(frame: AthenaConsoleFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	const readyHandlers = new Set<
		(address: AthenaConsoleReadyFrame['address']) => void
	>();
	const tokenRedacted = '<redacted>';

	function redact(message: string): string {
		return message.split(opts.pairingToken).join(tokenRedacted);
	}

	function emitClose(reason: string): void {
		for (const h of [...closeHandlers]) {
			try {
				h(reason);
			} catch {
				// listener errors must not break shutdown
			}
		}
	}

	async function connect(hello: ConsoleHelloPayload): Promise<void> {
		if (ws) throw new Error('console broker client already connected');
		const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const headers = {Authorization: `Bearer ${opts.pairingToken}`};
		const wsOpts = opts.tlsCaPath
			? {headers, ca: readFileSync(opts.tlsCaPath)}
			: {headers};
		ws = new WebSocket(opts.brokerUrl, wsOpts);

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finishOk = (): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				};
				const finishErr = (err: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err);
				};
				// Single timer covers both `open` and `ready` — a broker that accepts
				// the socket but never replies must still surface as a timeout.
				const timer = setTimeout(() => {
					finishErr(
						new Error(`console broker connect timed out after ${timeoutMs}ms`),
					);
				}, timeoutMs);

				ws!.once('open', () => {
					try {
						const helloFrame: AthenaConsoleHelloFrame = {
							kind: 'console.hello',
							frameId: makeFrameId(),
							sentAt: Date.now(),
							protocolVersion: 1,
							clientName: hello.clientName,
							clientVersion: hello.clientVersion,
						};
						ws!.send(JSON.stringify(helloFrame));
					} catch (err) {
						finishErr(err instanceof Error ? err : new Error(String(err)));
					}
				});

				ws!.once('error', err => {
					finishErr(
						new Error(`console broker connect failed: ${redact(err.message)}`),
					);
				});

				ws!.once('close', (code, reasonBuf) => {
					if (!ready) {
						const reason = reasonBuf?.toString() ?? '';
						finishErr(
							new Error(
								`console broker closed before ready (code=${code}${reason ? ` reason=${reason}` : ''})`,
							),
						);
					}
				});

				ws!.on('message', data => {
					let parsed: AthenaConsoleFrame;
					try {
						parsed = JSON.parse(String(data)) as AthenaConsoleFrame;
					} catch (err) {
						opts.log(
							'warn',
							`console broker frame parse failed: ${redact(String(err))}`,
						);
						return;
					}
					if (!ready) {
						if (parsed.kind === 'console.ready') {
							ready = parsed;
							const address = parsed.address;
							for (const h of [...readyHandlers]) {
								try {
									h(address);
								} catch {
									// ready handlers must not break the connect path
								}
							}
							finishOk();
							return;
						}
						if (parsed.kind === 'console.error') {
							finishErr(
								new Error(
									`console broker rejected hello: ${parsed.code} ${parsed.message}`,
								),
							);
							return;
						}
						opts.log(
							'warn',
							`console broker pre-ready frame ignored: ${parsed.kind}`,
						);
						return;
					}
					for (const h of [...frameHandlers]) {
						try {
							h(parsed);
						} catch (err) {
							opts.log(
								'warn',
								`console frame handler threw: ${redact(err instanceof Error ? err.message : String(err))}`,
							);
						}
					}
				});
			});
		} catch (err) {
			try {
				ws?.terminate();
			} catch {
				// best-effort
			}
			ws = null;
			ready = null;
			throw err;
		}

		ws.on('close', (_code, reasonBuf) => {
			ws = null;
			ready = null;
			emitClose(reasonBuf?.toString() || 'closed');
		});
	}

	function close(reason: string): void {
		if (!ws) return;
		try {
			ws.close(1000, reason);
		} catch {
			ws.terminate();
		}
		ws = null;
		ready = null;
		emitClose(reason);
	}

	function sendFrame(frame: AthenaConsoleFrame): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			throw new Error('console broker client not connected');
		}
		ws.send(JSON.stringify(frame));
	}

	function onFrame(handler: (frame: AthenaConsoleFrame) => void): void {
		frameHandlers.add(handler);
	}

	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}

	function onReady(
		handler: (address: AthenaConsoleReadyFrame['address']) => void,
	): void {
		readyHandlers.add(handler);
	}

	return {
		connect,
		close,
		sendFrame,
		onFrame,
		onReady,
		onClose,
		getReadyAddress: () => ready?.address ?? null,
		isReady: () => ready !== null,
	};
}

let frameCounter = 0;
function makeFrameId(): string {
	frameCounter = (frameCounter + 1) % 1_000_000;
	return `f${Date.now().toString(36)}-${frameCounter.toString(36)}`;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/client.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Run typecheck + lint**

Run:

```bash
npm run typecheck
npm run lint:eslint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/adapters/console/client.ts src/gateway/adapters/console/client.test.ts
git commit -m "feat(console): add broker client with hello/ready handshake"
```

---

## Task K3: Adapter `start` + inbound message normalization

**Files:**

- Create: `src/gateway/adapters/console/adapter.test.ts`
- Modify: `src/gateway/adapters/console/adapter.ts`

This task makes the adapter actually open a broker connection on `start`, normalize incoming `console.message.in` frames into `NormalizedInbound`, and emit them via `ctx.emitInbound`.

- [ ] **Step 1: Write the inbound test first (with a fake broker client)**

Create `src/gateway/adapters/console/adapter.test.ts`:

```typescript
import {describe, expect, it, vi} from 'vitest';
import {ConsoleAdapter} from './adapter';
import type {AthenaConsoleFrame} from '../../../shared/gateway-protocol';
import type {ConsoleBrokerClient} from './client';
import type {NormalizedInbound} from '../../../shared/gateway-protocol';

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

class FakeBrokerClient implements ConsoleBrokerClient {
	connected = false;
	closed = false;
	sent: AthenaConsoleFrame[] = [];
	private frameHandlers: Array<(f: AthenaConsoleFrame) => void> = [];
	private closeHandlers: Array<(reason: string) => void> = [];
	private readyHandlers: Array<(addr: {runnerId: string}) => void> = [];
	private ready = false;

	async connect(): Promise<void> {
		this.connected = true;
		this.ready = true;
		for (const h of this.readyHandlers) h({runnerId: 'r1'});
	}
	close(reason: string): void {
		this.closed = true;
		this.connected = false;
		this.ready = false;
		for (const h of this.closeHandlers) h(reason);
	}
	sendFrame(frame: AthenaConsoleFrame): void {
		this.sent.push(frame);
	}
	onFrame(handler: (f: AthenaConsoleFrame) => void): void {
		this.frameHandlers.push(handler);
	}
	onReady(handler: (addr: {runnerId: string}) => void): void {
		this.readyHandlers.push(handler);
	}
	onClose(handler: (reason: string) => void): void {
		this.closeHandlers.push(handler);
	}
	getReadyAddress() {
		return this.ready ? {runnerId: 'r1'} : null;
	}
	isReady(): boolean {
		return this.ready;
	}

	deliver(frame: AthenaConsoleFrame): void {
		for (const h of this.frameHandlers) h(frame);
	}

	/** Simulates a connection blip: close → open → ready. */
	simulateReconnect(): void {
		for (const h of this.closeHandlers) h('blip');
		this.ready = true;
		for (const h of this.readyHandlers) h({runnerId: 'r1'});
	}
}

function makeAdapter(
	overrides: Partial<ConstructorParameters<typeof ConsoleAdapter>[0]> = {},
) {
	const fake = new FakeBrokerClient();
	const adapter = new ConsoleAdapter({
		brokerUrl: 'wss://broker.test/adapter',
		runnerId: 'r1',
		workspaceId: 'ws1',
		pairingToken: 'tok',
		brokerClientFactory: () => fake,
		...overrides,
	});
	return {adapter, fake};
}

async function startAdapter(adapter: ConsoleAdapter, log: LogFn = () => {}) {
	const abort = new AbortController();
	const inbound: NormalizedInbound[] = [];
	const health: unknown[] = [];
	await adapter.start({
		log,
		signal: abort.signal,
		emitInbound: msg => inbound.push(msg),
		emitHealth: sample => health.push(sample),
	});
	return {abort, inbound, health};
}

describe('ConsoleAdapter — inbound', () => {
	it('normalizes console.message.in into a NormalizedInbound and emits it', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);

		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f1',
			sentAt: 1_700_000_000_000,
			address: {
				runnerId: 'r1',
				workspaceId: 'ws1',
				userId: 'u42',
				threadId: 't1',
			},
			messageId: 'm-1',
			idempotencyKey: 'broker-key-1',
			text: 'hello athena',
		});

		await vi.waitFor(() => expect(handle.inbound).toHaveLength(1));
		const msg = handle.inbound[0]!;
		expect(msg.text).toBe('hello athena');
		expect(msg.location.channelId).toBe('console');
		expect(msg.location.peer?.id).toBe('u42');
		expect(msg.location.thread?.id).toBe('t1');
		expect(msg.location.accountId).toBe('ws1');
		expect(msg.idempotencyKey).toBe('broker-key-1');
		expect(msg.providerMessageId).toBe('m-1');
		expect(msg.sender.id).toBe('u42');

		await adapter.stop('shutdown');
	});

	it('falls back to derived idempotency key when frame omits one', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f1',
			sentAt: 0,
			address: {runnerId: 'r1', userId: 'u42'},
			messageId: 'm-2',
			idempotencyKey: '',
			text: 'hi',
		});
		await vi.waitFor(() => expect(handle.inbound).toHaveLength(1));
		expect(handle.inbound[0]!.idempotencyKey).toBe('console:r1:m-2');
		await adapter.stop('shutdown');
	});

	it('drops console.message.in with empty text', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f',
			sentAt: 0,
			address: {runnerId: 'r1'},
			messageId: 'm',
			idempotencyKey: 'k',
			text: '',
		});
		await new Promise(r => setTimeout(r, 10));
		await adapter.stop('shutdown');
		expect(handle.inbound).toEqual([]);
	});

	it('refuses double-start', async () => {
		const {adapter} = makeAdapter();
		await startAdapter(adapter);
		await expect(startAdapter(adapter)).rejects.toThrow(/already started/);
		await adapter.stop('shutdown');
	});

	it('throws if pairing token cannot be loaded from token_path', async () => {
		const adapter = new ConsoleAdapter({
			brokerUrl: 'wss://broker.test/adapter',
			runnerId: 'r1',
			tokenPath: '/path/that/does/not/exist',
			brokerClientFactory: () => new FakeBrokerClient(),
		});
		await expect(startAdapter(adapter)).rejects.toThrow(/token_path/);
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: FAIL — `start()` currently throws "not yet implemented".

- [ ] **Step 3: Implement `start` and inbound normalization**

Replace `src/gateway/adapters/console/adapter.ts` (full file rewrite — the K1 stub is gone):

```typescript
/**
 * In-daemon console channel adapter.
 *
 * Conforms to `ChannelAdapter`. Opens a single outbound WSS connection to a
 * broker service and speaks the transport-neutral `AthenaConsoleFrame`
 * protocol. Inbound rich-client messages are normalized to
 * `NormalizedInbound` and surfaced through `AdapterContext.emitInbound`;
 * runtime replies and permission/question relays travel back to the broker
 * as console frames.
 *
 * Reconnect (with bounded backoff) lives in the lifecycle task K7; this
 * file's `start()` opens a single connection and surfaces a fatal error if
 * it fails.
 */

import {readFileSync} from 'node:fs';
import type {
	AdapterContext,
	AthenaConsoleFrame,
	AthenaConsoleInboundMessageFrame,
	ChannelAdapter,
	ChannelCapabilities,
	NormalizedInbound,
	OutboundMessage,
	PermissionRelayRequest,
	PermissionRelayResult,
	ProbeResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';
import {type ConsoleBrokerClient, createConsoleBrokerClient} from './client';
import type {ConsoleAdapterOptions, ConsoleBrokerClientFactory} from './types';

const CONSOLE_ID = 'console';
const CLIENT_NAME = 'athena-cli';
const CLIENT_VERSION = '0.0.0'; // TODO surface from package.json when wired in cli

export class ConsoleAdapter implements ChannelAdapter {
	readonly id = CONSOLE_ID;
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: true,
		relayPermission: true,
		relayQuestion: true,
	};

	private readonly opts: ConsoleAdapterOptions;
	private client: ConsoleBrokerClient | null = null;
	private ctx: AdapterContext | null = null;

	constructor(opts: ConsoleAdapterOptions) {
		this.opts = opts;
	}

	async start(ctx: AdapterContext): Promise<void> {
		if (this.client) {
			throw new Error('console adapter already started');
		}
		this.ctx = ctx;
		const pairingToken = resolvePairingToken(this.opts);
		const factory: ConsoleBrokerClientFactory =
			this.opts.brokerClientFactory ??
			(input => createConsoleBrokerClient(input));
		const client = factory({
			brokerUrl: this.opts.brokerUrl,
			pairingToken,
			...(this.opts.tlsCaPath !== undefined
				? {tlsCaPath: this.opts.tlsCaPath}
				: {}),
			log: ctx.log,
		});
		client.onFrame(frame => this.handleInboundFrame(frame));
		await client.connect({
			runnerId: this.opts.runnerId,
			clientName: CLIENT_NAME,
			clientVersion: CLIENT_VERSION,
		});
		this.client = client;
		ctx.emitHealth({at: Date.now(), transportOk: true});
		ctx.signal.addEventListener('abort', () => {
			this.client?.close('manager abort');
		});
	}

	async stop(_reason: StopReason): Promise<void> {
		this.client?.close('shutdown');
		this.client = null;
		this.ctx = null;
	}

	async send(_msg: OutboundMessage): Promise<SendResult> {
		throw new Error('console adapter: send not yet implemented');
	}

	async probe(): Promise<ProbeResult> {
		const ok = this.client?.isReady() ?? false;
		return {
			ok,
			detail: ok ? 'broker connected' : 'broker not connected',
			checkedAt: Date.now(),
		};
	}

	async requestPermissionVerdict(
		_req: PermissionRelayRequest,
		_signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		return {kind: 'no_relay'};
	}

	async requestQuestionAnswer(
		_req: QuestionRelayRequest,
		_signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		return {kind: 'no_relay'};
	}

	private handleInboundFrame(frame: AthenaConsoleFrame): void {
		if (frame.kind !== 'console.message.in') return;
		const inbound = normalizeInbound(frame, this.opts.runnerId);
		if (!inbound) return;
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			ctx.emitInbound(inbound);
		} catch (err) {
			ctx.log(
				'warn',
				`console emitInbound threw: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

function resolvePairingToken(opts: ConsoleAdapterOptions): string {
	if (opts.pairingToken !== undefined && opts.pairingToken.length > 0) {
		return opts.pairingToken;
	}
	if (opts.tokenPath !== undefined && opts.tokenPath.length > 0) {
		try {
			const value = readFileSync(opts.tokenPath, 'utf-8').trim();
			if (value.length === 0) {
				throw new Error(
					`console adapter: token_path ${opts.tokenPath} is empty`,
				);
			}
			return value;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			throw new Error(
				`console adapter: failed to read token_path ${opts.tokenPath}` +
					(code ? ` (${code})` : '') +
					(err instanceof Error ? `: ${err.message}` : ''),
			);
		}
	}
	throw new Error('console adapter: no pairing_token or token_path configured');
}

function normalizeInbound(
	frame: AthenaConsoleInboundMessageFrame,
	runnerId: string,
): NormalizedInbound | null {
	if (typeof frame.text !== 'string' || frame.text.length === 0) return null;
	const userId = frame.address.userId ?? 'console-user';
	const idempotencyKey =
		typeof frame.idempotencyKey === 'string' && frame.idempotencyKey.length > 0
			? frame.idempotencyKey
			: `console:${runnerId}:${frame.messageId}`;
	return {
		location: {
			channelId: CONSOLE_ID,
			accountId: frame.address.workspaceId ?? runnerId,
			peer: {id: userId, kind: 'user'},
			...(frame.address.threadId !== undefined
				? {thread: {id: frame.address.threadId}}
				: frame.address.conversationId !== undefined
					? {thread: {id: frame.address.conversationId}}
					: {}),
		},
		sender: {id: userId},
		text: frame.text,
		receivedAt: frame.sentAt,
		idempotencyKey,
		providerMessageId: frame.messageId,
	};
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Run typecheck + lint**

Run:

```bash
npm run typecheck
npm run lint:eslint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/adapters/console/adapter.ts src/gateway/adapters/console/adapter.test.ts
git commit -m "feat(console): connect on start and normalize inbound messages"
```

---

## Task K4: Implement outbound `send`

**Files:**

- Modify: `src/gateway/adapters/console/adapter.ts`
- Modify: `src/gateway/adapters/console/adapter.test.ts`

The adapter sends `console.message.out` frames to the broker for each runtime reply. The `OutboundMessage.idempotencyKey` is forwarded as the frame's `idempotencyKey` so the broker can dedupe redeliveries.

- [ ] **Step 1: Add the outbound test first**

Append to `src/gateway/adapters/console/adapter.test.ts` (before the closing of the `describe` block, or in a new `describe`):

```typescript
describe('ConsoleAdapter — outbound', () => {
	it('sends console.message.out with idempotency key and address derived from location', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);

		const result = await adapter.send({
			location: {
				channelId: 'console',
				accountId: 'ws1',
				peer: {id: 'u42', kind: 'user'},
				thread: {id: 't1'},
			},
			text: 'reply text',
			idempotencyKey: 'turn-abc',
		});

		expect(fake.sent).toHaveLength(1);
		const frame = fake.sent[0]!;
		expect(frame.kind).toBe('console.message.out');
		if (frame.kind !== 'console.message.out') return;
		expect(frame.text).toBe('reply text');
		expect(frame.idempotencyKey).toBe('turn-abc');
		expect(frame.address.runnerId).toBe('r1');
		expect(frame.address.workspaceId).toBe('ws1');
		expect(frame.address.userId).toBe('u42');
		expect(frame.address.threadId).toBe('t1');
		expect(result.providerMessageId).toBe(frame.messageId);

		await adapter.stop('shutdown');
	});

	it('throws if send is called before start', async () => {
		const {adapter} = makeAdapter();
		await expect(
			adapter.send({
				location: {channelId: 'console', accountId: 'ws1'},
				text: 't',
				idempotencyKey: 'k',
			}),
		).rejects.toThrow(/before start|not connected/);
	});
});
```

- [ ] **Step 2: Run tests and verify the new ones fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: the inbound tests still pass; the two new outbound tests fail with "send not yet implemented".

- [ ] **Step 3: Implement `send`**

Edit `src/gateway/adapters/console/adapter.ts`:

Replace the `send` method body:

```typescript
	async send(msg: OutboundMessage): Promise<SendResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			throw new Error('console adapter: send called before broker is ready');
		}
		const messageId = makeOutboundMessageId();
		const frame: AthenaConsoleFrame = {
			kind: 'console.message.out',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
				...(msg.location.peer?.id !== undefined
					? {userId: msg.location.peer.id}
					: {}),
				...(msg.location.thread?.id !== undefined
					? {threadId: msg.location.thread.id}
					: {}),
			},
			messageId,
			idempotencyKey: msg.idempotencyKey,
			text: msg.text,
		};
		client.sendFrame(frame);
		return {
			providerMessageId: messageId,
			deliveredAt: Date.now(),
		};
	}
```

Add the helpers at the bottom of the file (after `normalizeInbound`):

```typescript
let outboundCounter = 0;
function makeOutboundMessageId(): string {
	outboundCounter = (outboundCounter + 1) % 1_000_000;
	return `console-out-${Date.now().toString(36)}-${outboundCounter.toString(36)}`;
}

let frameCounter = 0;
function makeFrameId(): string {
	frameCounter = (frameCounter + 1) % 1_000_000;
	return `f${Date.now().toString(36)}-${frameCounter.toString(36)}`;
}
```

- [ ] **Step 4: Run tests and verify all pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: all tests in the file pass (inbound + outbound + lifecycle).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/adapters/console/adapter.ts src/gateway/adapters/console/adapter.test.ts
git commit -m "feat(console): send runtime replies as console.message.out"
```

---

## Task K5: Permission relay support

**Files:**

- Modify: `src/gateway/adapters/console/adapter.ts`
- Modify: `src/gateway/adapters/console/adapter.test.ts`

`requestPermissionVerdict` sends `console.permission.request` to the broker, registers a pending resolver keyed by `channelRequestId`, and resolves when the matching `console.permission.response` arrives. On `signal.abort`, it sends `console.permission.cancel` (added in Task K0) and resolves with `{kind: 'cancelled'}`. Late responses after settlement are dropped.

- [ ] **Step 1: Add permission relay tests**

Append to `src/gateway/adapters/console/adapter.test.ts`:

```typescript
describe('ConsoleAdapter — permission relay', () => {
	it('round-trips an allow verdict through the broker', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);

		const abort = new AbortController();
		const verdictPromise = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'abcde',
				toolName: 'shell',
				description: 'run ls',
				inputPreview: 'ls -la',
			},
			abort.signal,
		);

		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		const sent = fake.sent[0]!;
		expect(sent.kind).toBe('console.permission.request');
		if (sent.kind !== 'console.permission.request')
			throw new Error('wrong kind');
		expect(sent.channelRequestId).toBe('abcde');

		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'abcde',
			decision: 'allow',
		});

		const result = await verdictPromise;
		expect(result).toEqual({
			kind: 'verdict',
			behavior: 'allow',
			channelId: 'console',
		});

		await adapter.stop('shutdown');
	});

	it('round-trips a deny verdict', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'aaaaa',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'aaaaa',
			decision: 'deny',
		});
		expect((await p).kind).toBe('verdict');
		await adapter.stop('shutdown');
	});

	it('sends console.permission.cancel on signal abort', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'bbbbb',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		expect(fake.sent.length).toBe(2);
		const cancelFrame = fake.sent[1]!;
		expect(cancelFrame.kind).toBe('console.permission.cancel');
		if (cancelFrame.kind !== 'console.permission.cancel') {
			throw new Error('wrong kind');
		}
		expect(cancelFrame.channelRequestId).toBe('bbbbb');
		await adapter.stop('shutdown');
	});

	it('ignores late responses after cancellation', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'ccccc',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		await p;
		// late response — should be silently dropped
		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'late',
			sentAt: 0,
			channelRequestId: 'ccccc',
			decision: 'allow',
		});
		await new Promise(r => setTimeout(r, 10));
		await adapter.stop('shutdown');
		// no throw means we ignored the late frame correctly
	});

	it('cancels pending relays on stop with kind=cancelled', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'ddddd',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		await adapter.stop('shutdown');
		const result = await p;
		expect(result.kind).toBe('cancelled');
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: the new permission tests fail (returns `{kind: 'no_relay'}`).

- [ ] **Step 3: Implement permission relay**

Edit `src/gateway/adapters/console/adapter.ts`:

Add a private pending-relay registry as a class field. Inside the class, replace the `requestPermissionVerdict` stub and add a settle helper:

```typescript
	private readonly pendingPermissions = new Map<
		string,
		{
			resolve: (result: PermissionRelayResult) => void;
			abortListener: () => void;
			signal: AbortSignal;
		}
	>();

	requestPermissionVerdict(
		req: PermissionRelayRequest,
		signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			return Promise.resolve({kind: 'no_relay'});
		}
		if (signal.aborted) {
			return Promise.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
		client.sendFrame({
			kind: 'console.permission.request',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
			},
			channelRequestId: req.channelRequestId,
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
		});
		return new Promise<PermissionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pendingPermissions.get(req.channelRequestId);
				if (!entry) return;
				this.pendingPermissions.delete(req.channelRequestId);
				try {
					this.client?.sendFrame({
						kind: 'console.permission.cancel',
						frameId: makeFrameId(),
						sentAt: Date.now(),
						channelRequestId: req.channelRequestId,
						reason: 'resolved_by_other_channel',
					});
				} catch {
					// best-effort cancel
				}
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pendingPermissions.set(req.channelRequestId, {
				resolve,
				abortListener,
				signal,
			});
		});
	}

	private settlePermissionResponse(
		channelRequestId: string,
		decision: 'allow' | 'deny',
	): void {
		const entry = this.pendingPermissions.get(channelRequestId);
		if (!entry) return;
		this.pendingPermissions.delete(channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		entry.resolve({kind: 'verdict', behavior: decision, channelId: CONSOLE_ID});
	}

	private disposePermissions(): void {
		for (const [id, entry] of [...this.pendingPermissions.entries()]) {
			this.pendingPermissions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
	}
```

Wire the response into `handleInboundFrame`:

```typescript
	private handleInboundFrame(frame: AthenaConsoleFrame): void {
		switch (frame.kind) {
			case 'console.message.in': {
				const inbound = normalizeInbound(frame, this.opts.runnerId);
				if (!inbound || !this.ctx) return;
				try {
					this.ctx.emitInbound(inbound);
				} catch (err) {
					this.ctx.log(
						'warn',
						`console emitInbound threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				return;
			}
			case 'console.permission.response':
				this.settlePermissionResponse(frame.channelRequestId, frame.decision);
				return;
			default:
				return;
		}
	}
```

Update `stop()` to dispose pending relays:

```typescript
	async stop(_reason: StopReason): Promise<void> {
		this.disposePermissions();
		this.client?.close('shutdown');
		this.client = null;
		this.ctx = null;
	}
```

- [ ] **Step 4: Run tests and verify all pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: all permission tests pass plus prior inbound/outbound tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/adapters/console/adapter.ts src/gateway/adapters/console/adapter.test.ts
git commit -m "feat(console): relay permission requests through broker"
```

---

## Task K6: Question relay support

**Files:**

- Modify: `src/gateway/adapters/console/adapter.ts`
- Modify: `src/gateway/adapters/console/adapter.test.ts`

Same shape as K5 with `QuestionRelay*` payloads, including answer key validation: the broker may return answers for any subset of the question keys, but unknown keys are dropped silently and missing keys are surfaced as a `cancelled` result with reason `auto_resolved` (per `RelayCancelReason`'s existing semantics — there is no `'malformed_response'` reason).

- [ ] **Step 1: Add question relay tests**

Append to `src/gateway/adapters/console/adapter.test.ts`:

```typescript
describe('ConsoleAdapter — question relay', () => {
	const sampleQuestion = {
		key: 'priority',
		header: 'Priority',
		question: 'Which priority?',
		multi_select: false,
		options: [
			{label: 'high', description: 'P0'},
			{label: 'low', description: 'P3'},
		],
	};

	it('round-trips an answer through the broker', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{
				channelRequestId: 'qabcd',
				title: 'Pick one',
				questions: [sampleQuestion],
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(fake.sent[0]!.kind).toBe('console.question.request');

		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qabcd',
			answers: {priority: 'high'},
		});

		const result = await p;
		expect(result.kind).toBe('answer');
		if (result.kind !== 'answer') throw new Error('wrong kind');
		expect(result.answers).toEqual({priority: 'high'});
		expect(result.channelId).toBe('console');

		await adapter.stop('shutdown');
	});

	it('sends console.question.cancel on signal abort', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qaa', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		expect(fake.sent.length).toBe(2);
		const cancelFrame = fake.sent[1]!;
		expect(cancelFrame.kind).toBe('console.question.cancel');
		if (cancelFrame.kind !== 'console.question.cancel') {
			throw new Error('wrong kind');
		}
		expect(cancelFrame.channelRequestId).toBe('qaa');
		await adapter.stop('shutdown');
	});

	it('drops answers for unknown keys but accepts the rest', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qbb', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qbb',
			answers: {priority: 'high', unknown: 'ignored'},
		});
		const result = await p;
		expect(result.kind).toBe('answer');
		if (result.kind !== 'answer') throw new Error('wrong kind');
		expect(result.answers).toEqual({priority: 'high'});
		await adapter.stop('shutdown');
	});

	it('returns cancelled when no answers match question keys', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qcc', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qcc',
			answers: {totally: 'wrong'},
		});
		const result = await p;
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: the question tests fail with `no_relay`.

- [ ] **Step 3: Implement question relay**

Edit `src/gateway/adapters/console/adapter.ts`:

Add a parallel pending registry, replace the `requestQuestionAnswer` stub, and dispose questions in `stop`. Inside the class:

```typescript
	private readonly pendingQuestions = new Map<
		string,
		{
			questionKeys: string[];
			resolve: (result: QuestionRelayResult) => void;
			abortListener: () => void;
			signal: AbortSignal;
		}
	>();

	requestQuestionAnswer(
		req: QuestionRelayRequest,
		signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			return Promise.resolve({kind: 'no_relay'});
		}
		if (signal.aborted) {
			return Promise.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
		client.sendFrame({
			kind: 'console.question.request',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
			},
			channelRequestId: req.channelRequestId,
			title: req.title,
			questions: req.questions,
		});
		return new Promise<QuestionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pendingQuestions.get(req.channelRequestId);
				if (!entry) return;
				this.pendingQuestions.delete(req.channelRequestId);
				try {
					this.client?.sendFrame({
						kind: 'console.question.cancel',
						frameId: makeFrameId(),
						sentAt: Date.now(),
						channelRequestId: req.channelRequestId,
						reason: 'resolved_by_other_channel',
					});
				} catch {
					// best-effort cancel
				}
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pendingQuestions.set(req.channelRequestId, {
				questionKeys: req.questions.map(q => q.key),
				resolve,
				abortListener,
				signal,
			});
		});
	}

	private settleQuestionResponse(
		channelRequestId: string,
		answers: Record<string, string>,
	): void {
		const entry = this.pendingQuestions.get(channelRequestId);
		if (!entry) return;
		const filtered: Record<string, string> = {};
		for (const key of entry.questionKeys) {
			const value = answers[key];
			if (typeof value === 'string') filtered[key] = value;
		}
		this.pendingQuestions.delete(channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		if (Object.keys(filtered).length === 0) {
			entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
			return;
		}
		entry.resolve({kind: 'answer', answers: filtered, channelId: CONSOLE_ID});
	}

	private disposeQuestions(): void {
		for (const [id, entry] of [...this.pendingQuestions.entries()]) {
			this.pendingQuestions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
	}
```

Extend `handleInboundFrame` switch with the question response case:

```typescript
			case 'console.question.response':
				this.settleQuestionResponse(frame.channelRequestId, frame.answers);
				return;
```

Extend `stop` to also dispose questions:

```typescript
	async stop(_reason: StopReason): Promise<void> {
		this.disposePermissions();
		this.disposeQuestions();
		this.client?.close('shutdown');
		this.client = null;
		this.ctx = null;
	}
```

- [ ] **Step 4: Run tests and verify all pass**

Run:

```bash
npx vitest run src/gateway/adapters/console/adapter.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/adapters/console/adapter.ts src/gateway/adapters/console/adapter.test.ts
git commit -m "feat(console): relay question requests through broker"
```

---

## Task K7: Reconnect with bounded backoff

**Files:**

- Modify: `src/gateway/adapters/console/client.ts`
- Modify: `src/gateway/adapters/console/client.test.ts`
- Modify: `src/gateway/adapters/console/adapter.ts`

Add a reconnect loop on top of the broker client. On unexpected close after a successful `ready`, the client schedules retries with full-jitter backoff (1s → 2s → 4s → 8s → 16s → 30s, capped). Pending relays are **disposed (cancelled with reason `connection_lost`) immediately on broker close** — the broker, not the adapter, is responsible for redelivering relay state to whichever rich client is connected next, and a stranded `Promise` waiting for a verdict that will never arrive is worse than a clean cancellation.

Because `console.ready` is consumed inside the client and never delivered through `onFrame`, the client also exposes an `onReady` callback that fires both after the initial handshake and after every successful reconnect. The adapter subscribes to `onReady` to flip its health sample back to `transportOk: true` immediately, instead of relying on an unrelated subsequent frame.

We do not rebuild the existing first-party `transport/wsClient.ts` reconnect logic because it speaks `ControlEnvelope`, not `AthenaConsoleFrame`; layer-wise, console adapter code lives under `gateway/adapters/console/` and owns its transport.

- [ ] **Step 1: Add reconnect tests**

Append to `src/gateway/adapters/console/client.test.ts`:

```typescript
describe('ConsoleBrokerClient — reconnect', () => {
	let server: WebSocketServer;
	let port: number;
	let acceptCount = 0;

	beforeEach(async () => {
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		acceptCount = 0;
		server.on('connection', (ws, _req) => {
			acceptCount++;
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
			});
		});
	});

	afterEach(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	it('reconnects after server-initiated close (post-ready)', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: `ws://127.0.0.1:${port}/adapter`,
			pairingToken: 'tok',
			log: () => {},
			reconnect: {initialDelayMs: 5, maxDelayMs: 50},
		});

		const closes: string[] = [];
		client.onClose(reason => closes.push(reason));

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(acceptCount).toBe(1);

		// kill the only server-side socket; client should reconnect
		for (const ws of server.clients) ws.terminate();

		await vi.waitFor(() => expect(acceptCount).toBeGreaterThanOrEqual(2), {
			timeout: 1000,
		});
		expect(client.isReady()).toBe(true);
		client.close('done');
	});

	it('stops reconnecting after explicit close()', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: `ws://127.0.0.1:${port}/adapter`,
			pairingToken: 'tok',
			log: () => {},
			reconnect: {initialDelayMs: 5, maxDelayMs: 50},
		});
		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		client.close('done');
		await new Promise(r => setTimeout(r, 100));
		expect(acceptCount).toBe(1);
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run src/gateway/adapters/console/client.test.ts
```

Expected: reconnect tests fail (the client never reconnects today).

- [ ] **Step 3: Implement reconnect in the client**

Edit `src/gateway/adapters/console/client.ts`:

Add a reconnect option to `ConsoleBrokerClientOptions`:

```typescript
export type ConsoleReconnectOptions = {
	initialDelayMs?: number;
	maxDelayMs?: number;
};

export type ConsoleBrokerClientOptions = {
	brokerUrl: string;
	pairingToken: string;
	tlsCaPath?: string;
	log: ConsoleBrokerClientLogger;
	connectTimeoutMs?: number;
	reconnect?: ConsoleReconnectOptions;
};
```

Refactor `createConsoleBrokerClient` so the `connect` method (renamed `attemptConnect` internally) is used both for the initial connect and reconnect attempts. After `ready`, attach a permanent `close` handler that kicks off reconnect unless `closeRequested` is set. Skeleton:

```typescript
export function createConsoleBrokerClient(
	opts: ConsoleBrokerClientOptions,
): ConsoleBrokerClient {
	const reconnect = opts.reconnect;
	const initialDelay = reconnect?.initialDelayMs ?? 1_000;
	const maxDelay = reconnect?.maxDelayMs ?? 30_000;
	let ws: WebSocket | null = null;
	let ready: AthenaConsoleReadyFrame | null = null;
	let closeRequested = false;
	let reconnectAttempt = 0;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let lastHello: ConsoleHelloPayload | null = null;
	const frameHandlers = new Set<(frame: AthenaConsoleFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	const readyHandlers = new Set<
		(address: AthenaConsoleReadyFrame['address']) => void
	>();
	const tokenRedacted = '<redacted>';

	function redact(message: string): string {
		return message.split(opts.pairingToken).join(tokenRedacted);
	}

	function scheduleReconnect(): void {
		if (closeRequested || !lastHello) return;
		const exp = Math.min(maxDelay, initialDelay * 2 ** reconnectAttempt);
		const delay = Math.floor(Math.random() * exp);
		reconnectAttempt++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void attemptConnect(lastHello!).then(
				() => {
					reconnectAttempt = 0;
				},
				err => {
					opts.log(
						'warn',
						`console broker reconnect failed: ${redact(err instanceof Error ? err.message : String(err))}`,
					);
					scheduleReconnect();
				},
			);
		}, delay);
	}

	function emitClose(reason: string): void {
		for (const h of [...closeHandlers]) {
			try {
				h(reason);
			} catch {
				// noop
			}
		}
	}

	async function attemptConnect(hello: ConsoleHelloPayload): Promise<void> {
		const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const headers = {Authorization: `Bearer ${opts.pairingToken}`};
		const wsOpts = opts.tlsCaPath
			? {headers, ca: readFileSync(opts.tlsCaPath)}
			: {headers};
		const next = new WebSocket(opts.brokerUrl, wsOpts);
		ws = next;
		ready = null;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				next.terminate();
				reject(
					new Error(`console broker connect timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);

			next.once('open', () => {
				clearTimeout(timer);
				try {
					next.send(
						JSON.stringify({
							kind: 'console.hello',
							frameId: makeFrameId(),
							sentAt: Date.now(),
							protocolVersion: 1,
							clientName: hello.clientName,
							clientVersion: hello.clientVersion,
						}),
					);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			next.once('error', err => {
				clearTimeout(timer);
				reject(
					new Error(`console broker connect failed: ${redact(err.message)}`),
				);
			});

			const earlyCloseListener = (code: number, reasonBuf: Buffer): void => {
				if (!ready) {
					clearTimeout(timer);
					reject(
						new Error(
							`console broker closed before ready (code=${code}${reasonBuf.length ? ` reason=${reasonBuf.toString()}` : ''})`,
						),
					);
				}
			};
			next.once('close', earlyCloseListener);

			next.on('message', data => {
				let parsed: AthenaConsoleFrame;
				try {
					parsed = JSON.parse(String(data)) as AthenaConsoleFrame;
				} catch (err) {
					opts.log(
						'warn',
						`console broker frame parse failed: ${redact(String(err))}`,
					);
					return;
				}
				if (!ready) {
					if (parsed.kind === 'console.ready') {
						ready = parsed;
						next.removeListener('close', earlyCloseListener);
						const address = parsed.address;
						for (const h of [...readyHandlers]) {
							try {
								h(address);
							} catch {
								// ready handlers must not break the connect path
							}
						}
						resolve();
						return;
					}
					if (parsed.kind === 'console.error') {
						reject(
							new Error(
								`console broker rejected hello: ${parsed.code} ${parsed.message}`,
							),
						);
						return;
					}
					return;
				}
				for (const h of [...frameHandlers]) {
					try {
						h(parsed);
					} catch (err) {
						opts.log(
							'warn',
							`console frame handler threw: ${redact(err instanceof Error ? err.message : String(err))}`,
						);
					}
				}
			});
		});

		// Permanent close listener — drives reconnect.
		next.on('close', (_code, reasonBuf) => {
			if (next !== ws) return; // a later attempt has already taken over
			ws = null;
			ready = null;
			emitClose(reasonBuf?.toString() || 'closed');
			if (!closeRequested) scheduleReconnect();
		});
	}

	async function connect(hello: ConsoleHelloPayload): Promise<void> {
		if (ws) throw new Error('console broker client already connected');
		closeRequested = false;
		lastHello = hello;
		await attemptConnect(hello);
	}

	function close(reason: string): void {
		closeRequested = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (ws) {
			try {
				ws.close(1000, reason);
			} catch {
				ws.terminate();
			}
		}
		ws = null;
		ready = null;
		emitClose(reason);
	}

	function sendFrame(frame: AthenaConsoleFrame): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			throw new Error('console broker client not connected');
		}
		ws.send(JSON.stringify(frame));
	}

	function onFrame(handler: (frame: AthenaConsoleFrame) => void): void {
		frameHandlers.add(handler);
	}
	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}
	function onReady(
		handler: (address: AthenaConsoleReadyFrame['address']) => void,
	): void {
		readyHandlers.add(handler);
	}

	return {
		connect,
		close,
		sendFrame,
		onFrame,
		onReady,
		onClose,
		getReadyAddress: () => ready?.address ?? null,
		isReady: () => ready !== null,
	};
}
```

- [ ] **Step 4: Add adapter-side reconnect handling tests first**

Append to `src/gateway/adapters/console/adapter.test.ts`:

```typescript
describe('ConsoleAdapter — reconnect health + relay disposal', () => {
	it('emits transportOk:false then transportOk:true on a broker reconnect', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		expect(handle.health.at(-1)).toMatchObject({transportOk: true});
		fake.simulateReconnect();
		// Two more samples: false then true.
		const last = handle.health.at(-1) as {transportOk: boolean};
		const prev = handle.health.at(-2) as {transportOk: boolean};
		expect(prev.transportOk).toBe(false);
		expect(last.transportOk).toBe(true);
		await adapter.stop('shutdown');
	});

	it('disposes pending permission relays as cancelled when broker closes', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'eeeee',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		// Broker connection blip BEFORE the user has acted.
		fake.simulateReconnect();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});

	it('disposes pending question relays as cancelled when broker closes', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{
				channelRequestId: 'qeee',
				title: 't',
				questions: [
					{
						key: 'k',
						header: 'h',
						question: 'q',
						multi_select: false,
						options: [{label: 'a', description: ''}],
					},
				],
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.simulateReconnect();
		expect((await p).kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});
});
```

- [ ] **Step 5: Wire `onReady` + dispose-on-close into the adapter**

Edit `src/gateway/adapters/console/adapter.ts`. Replace the body of `start()` so the health flips are driven by `onReady` and `onClose` rather than by an ad-hoc check inside `handleInboundFrame`:

```typescript
	async start(ctx: AdapterContext): Promise<void> {
		if (this.client) {
			throw new Error('console adapter already started');
		}
		this.ctx = ctx;
		const pairingToken = resolvePairingToken(this.opts);
		const factory: ConsoleBrokerClientFactory =
			this.opts.brokerClientFactory ??
			(input => createConsoleBrokerClient(input));
		const client = factory({
			brokerUrl: this.opts.brokerUrl,
			pairingToken,
			...(this.opts.tlsCaPath !== undefined
				? {tlsCaPath: this.opts.tlsCaPath}
				: {}),
			log: ctx.log,
		});
		client.onFrame(frame => this.handleInboundFrame(frame));
		client.onReady(_addr => {
			ctx.emitHealth({at: Date.now(), transportOk: true});
		});
		client.onClose(reason => {
			// Pending relays will not be answered by the next connection — the
			// broker has no replay obligation for this adapter version. Cancel
			// them so awaiting callers don't dangle.
			this.disposePermissions('connection_lost');
			this.disposeQuestions('connection_lost');
			ctx.emitHealth({
				at: Date.now(),
				transportOk: false,
				note: `broker connection closed: ${reason}`,
			});
		});
		await client.connect({
			runnerId: this.opts.runnerId,
			clientName: CLIENT_NAME,
			clientVersion: CLIENT_VERSION,
		});
		this.client = client;
		ctx.signal.addEventListener('abort', () => {
			this.client?.close('manager abort');
		});
	}
```

The `brokerReady` field introduced earlier in this task is no longer needed — `onReady` is authoritative — so remove it. `handleInboundFrame` reverts to the plain switch from K5/K6 (no `if (client.isReady() && !brokerReady)` block).

Update `disposePermissions` and `disposeQuestions` to accept a reason so close-driven disposal can be distinguished from shutdown disposal in callers' results:

```typescript
	private disposePermissions(
		reason: 'auto_resolved' | 'connection_lost' = 'auto_resolved',
	): void {
		for (const [id, entry] of [...this.pendingPermissions.entries()]) {
			this.pendingPermissions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason});
		}
	}

	private disposeQuestions(
		reason: 'auto_resolved' | 'connection_lost' = 'auto_resolved',
	): void {
		for (const [id, entry] of [...this.pendingQuestions.entries()]) {
			this.pendingQuestions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason});
		}
	}
```

`stop()` keeps calling them with the default reason; the close handler passes `'connection_lost'` explicitly.

- [ ] **Step 6: Run client + adapter tests and verify they pass**

Run:

```bash
npx vitest run src/gateway/adapters/console
```

Expected: all tests pass — handshake, inbound, outbound, permission relay, question relay, reconnect, and the new disposal/health-flip cases.

- [ ] **Step 7: Run typecheck + lint**

Run:

```bash
npm run typecheck
npm run lint:eslint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/adapters/console/client.ts src/gateway/adapters/console/client.test.ts src/gateway/adapters/console/adapter.ts src/gateway/adapters/console/adapter.test.ts
git commit -m "feat(console): reconnect broker client with bounded backoff"
```

---

## Task K8: Sample sidecar config + operator guide

**Files:**

- Create: `docs/guides/athena-console-channel.md`

This is a docs-only task; no code changes. The guide explains pairing flow, local dev setup, security model, and smoke test.

- [ ] **Step 1: Write the operator guide**

Write `docs/guides/athena-console-channel.md`:

```markdown
# Athena Console channel

The `console` channel adapter pairs an Athena CLI runtime with a broker
service so that any rich client (browser, mobile, desktop, partner UI) can
become a live conversational surface for the runtime. The adapter speaks
the `athena-console` protocol (see `src/shared/gateway-protocol/athenaConsole.ts`)
and is independent of the runtime control plane.

## Architecture

    Browser / mobile / desktop UI
              │  product session auth
              ▼
    Rich-client broker service          ← responsibility: routing,
              │                            user auth, message storage
              │  WSS (Authorization: Bearer <pairing token>)
              ▼
    CLI gateway `console` adapter
              │  ChannelAdapter contract
              ▼
    ChannelManager → Dispatcher → SessionRegistry → SessionBridge → Runtime
              ▲
              │
    RelayCoordinator for permission/question prompts

## Sidecar config

Place a JSON file at `~/.config/athena/channels/console.json` (mode 0600):

    {
      "broker_url": "wss://broker.example.com/api/runners/runner_123/console/adapter",
      "runner_id": "runner_123",
      "workspace_id": "workspace_42",
      "token_path": "/Users/you/.config/athena/console/pairing.jwt"
    }

Required keys:

- `broker_url` — `wss://` for production. `ws://` is allowed only for
  loopback hosts (`127.0.0.1`, `localhost`, `::1`).
- `runner_id` — broker-visible runner identity. One adapter socket binds to
  one runner identity for v1.
- `pairing_token` (inline) **or** `token_path` (file) — pairing JWT or
  bearer credential. Tokens travel in the `Authorization` header only;
  never in the URL query string and never in logs. **`token_path` and
  `tls_ca_path` must be absolute paths — `~` is not expanded.**

Optional keys:

- `workspace_id` — broker-visible workspace/account id. Surfaced on every
  outbound frame for routing.
- `tls_ca_path` — PEM bundle for self-signed broker TLS in dev.

## Pairing flow

1. The broker (e.g. dashboard Worker) issues a runner-scoped pairing token
   when the operator pairs a runner from the product UI.
2. The operator drops the token at `token_path` (or pastes inline as
   `pairing_token` for one-off tests).
3. On daemon start, the gateway reads the sidecar, instantiates the
   adapter, and opens a single WSS to `broker_url` with
   `Authorization: Bearer <token>`.
4. The adapter sends `console.hello`, the broker replies with
   `console.ready`, and the channel is live.

## Security model

- Tokens are loaded once at start. A future task adds rotation via SIGHUP or
  control-plane RPC; for now, restart the daemon to pick up a new token.
- Tokens are redacted from all log output and thrown errors.
- Outbound frames carry `runnerId` and `workspaceId`. Routing across runners
  is the broker's responsibility — the adapter binds to one runner.
- Rich-client socket auth (browser session, mobile JWT, etc.) is the
  broker's responsibility; the CLI adapter never sees end-user credentials.

## Local dev with a fake broker

A 60-line WS server that accepts the adapter and replays canned frames is
enough to drive every code path in `src/gateway/adapters/console/`:

    import {WebSocketServer} from 'ws';
    const server = new WebSocketServer({port: 8787});
    server.on('connection', ws => {
      ws.on('message', data => {
        const frame = JSON.parse(String(data));
        if (frame.kind === 'console.hello') {
          ws.send(JSON.stringify({
            kind: 'console.ready', frameId: 'r', sentAt: Date.now(),
            protocolVersion: 1, brokerName: 'fake', address: {runnerId: 'r1'},
          }));
          // simulate an inbound user message
          setTimeout(() => ws.send(JSON.stringify({
            kind: 'console.message.in', frameId: 'm1', sentAt: Date.now(),
            address: {runnerId: 'r1', userId: 'tester'},
            messageId: 'm1', idempotencyKey: 'fake:r1:m1', text: 'hello',
          })), 200);
        }
      });
    });

Sidecar pointing at this fake:

    {
      "broker_url": "ws://127.0.0.1:8787/adapter",
      "runner_id": "r1",
      "pairing_token": "anything"
    }

Start the gateway, register a runtime, and verify:

- `athena gateway status --json` shows the `console` adapter healthy.
- The fake's "hello" message reaches the runtime.
- The runtime's reply arrives back at the fake broker as
  `console.message.out`.
- Trigger a permission prompt; the broker receives
  `console.permission.request`, replies with `console.permission.response`,
  and the runtime continues with the chosen verdict.

## Failure modes

- **Broker unreachable on start:** the adapter's `start()` rejects.
  `loadChannelSidecars` already treats per-channel start failure as a
  non-fatal warning (other channels keep running). Restart the daemon once
  the broker is reachable.
- **Token rejected:** broker sends `console.error` with code
  `unauthorized`. Adapter exits start; restart with a refreshed token.
- **Connection blip after ready:** the broker client reconnects with full-
  jitter backoff (1s → 30s, capped). Pending relays are immediately
  cancelled with reason `connection_lost` — the runtime is expected to
  re-prompt if the user has not yet acted. The broker has no replay
  obligation in this adapter version; persistence of pending relays
  across reconnect is out of scope.
- **Daemon shutdown:** all pending relays resolve as `cancelled`; the
  broker socket closes with status 1000 and no reconnect is attempted.

## Smoke test checklist (real broker)

1. Pair a runner in the product UI and copy the token to `token_path`.
2. Start the gateway daemon.
3. Open the rich-client UI, navigate to the runner's Console surface.
4. Type a prompt — verify the assistant replies inline.
5. Trigger a tool that needs permission — verify the modal appears and the
   verdict round-trips.
6. Trigger a question prompt — verify answers round-trip.
7. Restart the daemon — verify the UI shows `disconnected` until the
   adapter reconnects.

## Companion broker work

The first broker is the dashboard Worker (separate repo). It must:

- Expose `GET /api/runners/:runnerId/console/adapter` for the CLI WSS.
- Expose `GET /api/runners/:runnerId/console/ws` for browser/mobile UI.
- Authenticate the adapter route via the existing instance-pairing JWT.
- Authenticate browser/mobile routes via dashboard user session auth.
- Verify the user has access to the runner/workspace before joining the
  console room.
- Maintain one active adapter socket per runner, fan out to many
  browser/mobile sockets subscribed to the same runner.
- Forward browser/mobile messages to the adapter as `console.message.in`.
- Broadcast `console.message.out` and relay frames to subscribed UI
  sockets.
- Persist console messages so a refresh shows recent conversation state.

UI tab requirements (dashboard repo): conversation transcript, composer,
connection status indicator, permission/question modals, empty state for
no paired runner, reconnect/error states.
```

- [ ] **Step 2: Verify the doc renders without dead links**

Run:

```bash
ls docs/guides/athena-console-channel.md
```

Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add docs/guides/athena-console-channel.md
git commit -m "docs(console): add console channel operator guide"
```

---

## Task K9: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Run all gates**

Run each in order; do not proceed if any fails:

```bash
npm run typecheck
npm run lint:eslint
npm run lint:dead
npm test
npm run build
```

Expected: all green. `lint:dead` (knip) should not flag any new file — every export has a consumer (registry imports `consoleModule`; module imports `ConsoleAdapter`; adapter imports the client; tests cover the rest).

- [ ] **Step 2: Confirm registry round-trip**

Run:

```bash
npx vitest run src/gateway/adapters/console
```

Expected: every adapter test (module, client, adapter) passes.

- [ ] **Step 3: Sanity-grep boundary correctness**

Run:

```bash
rg "from ['\"].*app/" src/gateway/adapters/console/
rg "from ['\"].*ui/" src/gateway/adapters/console/
rg "from ['\"].*harnesses/" src/gateway/adapters/console/
```

Expected: no matches. The console adapter must not import from `app/`, `ui/`, or `harnesses/` — it lives under `gateway/` and stays at the gateway boundary.

```bash
rg "ControlEnvelope|gateway/control/|gateway/transport/" src/gateway/adapters/console/
```

Expected: no matches. Console frames are not control envelopes; the broker WS is independent of the runtime transport.

- [ ] **Step 4: Confirm token redaction**

Run:

```bash
rg -n "pairingToken|pairing_token" src/gateway/adapters/console/
```

Expected: matches in `client.ts`, `adapter.ts`, `module.ts`, and tests. Then verify each match either (a) reads the token, (b) writes it into the WS Authorization header, or (c) is in a test using a deliberately recognizable token. No match should construct a string containing the token for logging or error formatting — `redact()` is the only allowed sink.

- [ ] **Step 5: Build + run the daemon (manual smoke, optional)**

Run:

```bash
npm run build
node dist/athena-gateway.js
```

Expected: daemon starts. With a sidecar at `~/.config/athena/channels/console.json` pointing at a fake local broker, the console adapter logs a successful `ready` and stays connected until shutdown.

---

## Completion Criteria

All of the following must be true after Task K9:

- `AthenaConsoleFrame` includes `console.permission.cancel` and `console.question.cancel` kinds, exported from the shared barrel.
- `console` is a built-in adapter module — `findAdapterModule('console')` returns `consoleModule`.
- `src/gateway/adapters/console/` contains `module.ts`, `adapter.ts`, `client.ts`, `types.ts`, `index.ts`, plus their tests.
- Inbound `console.message.in` frames produce a single `NormalizedInbound` per frame, with `channelId = "console"` and `idempotencyKey` taken from the frame (or derived `"console:<runnerId>:<messageId>"` when the frame omits it).
- Outbound `OutboundMessage` writes a `console.message.out` frame whose `idempotencyKey` matches the input.
- `requestPermissionVerdict` and `requestQuestionAnswer` round-trip through the broker, send `console.permission.cancel` / `console.question.cancel` on `signal.abort`, and dispose pending entries on `stop()` and on broker close.
- `ConsoleBrokerClient` exposes `onReady`; the adapter emits `transportOk: true` on every ready (initial + post-reconnect) and `transportOk: false` on every close.
- Broker client connect-timeout fires whether the broker fails to accept the socket OR accepts it but never sends `console.ready`.
- Broker client reconnects on unexpected close (post-ready) with full-jitter backoff capped at 30s; pending relays are cancelled with reason `connection_lost`; explicit `close()` halts reconnects.
- Pairing token travels via `Authorization: Bearer …`. No occurrence in URL query strings, logs, or thrown error messages.
- `wss://` is required outside loopback URLs; the module rejects misconfigured sidecars at parse time.
- `npm run typecheck`, `npm run lint:eslint`, `npm run lint:dead`, `npm test`, `npm run build` all pass.
- `docs/guides/athena-console-channel.md` documents pairing flow, security model, local dev setup, failure modes, and smoke test.

## Risks And Watchpoints

- **Do not let `AthenaConsoleFrame` leak into `ControlEnvelope` paths.** The two protocols share no producers or consumers; mixing them is a layering bug.
- **Do not import `gateway/transport/wsClient` in the console adapter.** That client speaks `ControlEnvelope`; the console client is a separate module local to `gateway/adapters/console/`.
- **Pending relays do not survive reconnect.** A future task can add server-side replay (analogous to R7 in the remote-gateway plan), but for v1 a reconnect resolves pending relays as `cancelled`.
- **Cancel frames are dedicated kinds.** `console.permission.cancel` and `console.question.cancel` (added in K0) carry `channelRequestId` directly. Brokers must dispatch on the frame kind, not on `console.error{code: 'cancelled'}` — the latter is reserved for protocol-level errors.
- **Multi-tenancy:** v1 binds one adapter socket to one runner identity. Field shapes (`AthenaConsoleAddress.runnerId`, `workspaceId`) are forward-compatible with multi-runtime routing; do not introduce singleton assumptions in adapter state.
- **Idempotency keys for outbound:** the adapter forwards `OutboundMessage.idempotencyKey` verbatim. Brokers that retry deliveries to rich clients must dedupe on this key. Do not synthesize a new key inside the adapter.
- **`skipChannelLoad: true`:** the existing project memory note about daemon-booting tests applies. The adapter tests in this plan use a fake broker client (no daemon spin-up), so the note isn't load-bearing here — but if a future end-to-end test boots the daemon to exercise console-via-`startDaemon`, it must pass `skipChannelLoad: true`.

## Companion work (out of scope for this CLI plan)

The first broker is the dashboard Worker; UI is the dashboard Console tab.
Both live in a separate repo and are gated by a compatible `athena-console`
implementation. Documenting expected routes and behaviors here as a
forward reference; do not attempt to implement them in this plan.

### Dashboard Worker

- `GET /api/runners/:runnerId/console/adapter` — upgrade the paired CLI adapter WSS, authenticated with the existing instance-pairing JWT.
- `GET /api/runners/:runnerId/console/ws` — upgrade browser/mobile sockets, authenticated with dashboard user session auth.
- Verify user→runner/workspace authorization before joining a console room.
- One active adapter socket per runner; many subscribed UI sockets per runner.
- Forward UI messages to the adapter as `console.message.in`; broadcast adapter replies and relay frames to subscribed UI sockets.
- Persist console messages so a refresh shows recent conversation state. CLI gateway is not the source of dashboard chat history.

### Dashboard Console tab

- Conversation transcript, composer, connection status indicator.
- Permission and question modals driven by `console.*.request` frames.
- Empty state for no paired runner; reconnecting state; error state for permission denied or runner offline.
- Idempotent rendering by `messageId` and `channelRequestId`.
