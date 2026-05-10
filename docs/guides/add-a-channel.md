# Add a channel adapter

This guide walks through adding a new channel to Athena's gateway — the integration that lets external messaging surfaces (Telegram, Slack, a web dashboard, …) drive Athena turns and receive replies.

You only need to know your platform's API. The gateway handles routing, persistence, retries, idempotency, parking, and registration with the running Athena TUI.

## What you implement

Two interfaces, both from `@drisp/cli`'s `shared/gateway-protocol`:

- **`ChannelAdapter`** — the runtime: lifecycle, send, probe, optional relay handlers
- **`AdapterModule`** — the factory: parse a JSON sidecar config and construct the adapter

That's it. No DB writes, no retry logic, no UDS plumbing — those live in the gateway.

## Step-by-step

### 1. Sketch your config schema

Decide what your sidecar JSON file at `~/.config/athena/channels/<name>.json` will contain. For example, for an SMS-via-Twilio adapter:

```json
{
	"allowed_user_ids": ["+15551234567"],
	"account_sid": "AC...",
	"auth_token_env": "TWILIO_AUTH_TOKEN",
	"from_number": "+15557654321"
}
```

Conventions:

- `allowed_user_ids` is reserved — the gateway parses it into `ChannelSidecar.allowedUserIds`
- secrets go into `*_env` vars, never raw values
- file mode must be `0600` (the gateway rejects anything looser)

### 2. Implement `ChannelAdapter`

Create `src/gateway/adapters/twilio/adapter.ts`:

```ts
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelCapabilities,
	NormalizedInbound,
	OutboundMessage,
	ProbeResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';
import {peerLocation} from '../../../shared/gateway-protocol';

export type TwilioAdapterOptions = {
	accountSid: string;
	authToken: string;
	fromNumber: string;
	allowedUserIds: ReadonlyArray<string>;
};

export class TwilioAdapter implements ChannelAdapter {
	readonly id = 'twilio';
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: false,
		relayPermission: false,
		relayQuestion: false,
	};

	private ctx: AdapterContext | null = null;
	// ... your client, polling/webhook state ...

	constructor(private readonly opts: TwilioAdapterOptions) {}

	async start(ctx: AdapterContext): Promise<void> {
		this.ctx = ctx;
		// Spin up your transport (long-poll, websocket, webhook listener …).
		// On each inbound message, normalize and call ctx.emitInbound(...).
		// On transport state changes, call ctx.emitHealth({...}).
		// Return as soon as the transport is reachable; readiness > full sync.
	}

	async stop(_reason: StopReason): Promise<void> {
		// Tear down your transport. ctx.signal also fires on shutdown if you'd
		// rather wire abort into your loop.
		this.ctx = null;
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		// POST to your provider. Honour msg.idempotencyKey to avoid double-
		// posting on retry — the gateway's outbox will retry on failure.
		const providerMessageId = await postToTwilio(msg);
		return {providerMessageId, deliveredAt: Date.now()};
	}

	async probe(): Promise<ProbeResult> {
		// Cheap transport check (ping, /me, auth.test). < 2s.
		return {ok: true, checkedAt: Date.now()};
	}
}

function normalizeInboundSms(raw: unknown): NormalizedInbound {
	// Provider-specific → ChannelLocation + sender + text + idempotencyKey.
	return {
		location: peerLocation({
			channelId: 'twilio',
			accountId: 'main',
			peerId: '+15551234567',
		}),
		sender: {id: '+15551234567'},
		text: 'hello',
		receivedAt: Date.now(),
		idempotencyKey: 'twilio:msg:abc123', // must be stable across retries
		providerMessageId: 'SM...',
	};
}
```

Key rules:

- **`emitInbound` / `emitHealth` come from `ctx`**, not registered via `on(...)`. The gateway wires both before `start()` is called, so emitting during start is safe.
- **`idempotencyKey` is non-negotiable.** Use `update_id`, `client_msg_id`, `MessageSid` — anything stable across the provider's retries. Synthesize one from `(sender, timestamp, hash(text))` only as a last resort.
- **Capabilities are the source of truth.** Set `relayPermission: true` only if you also implement `requestPermissionVerdict`. Same for `relayQuestion`.
- **`start()` should resolve fast.** If the provider takes > 1s to handshake, do it in the background and emit a health sample when ready.

### 3. Implement `AdapterModule`

Create `src/gateway/adapters/twilio/module.ts`:

```ts
import type {AdapterModule} from '../../../shared/gateway-protocol';
import {TwilioAdapter, type TwilioAdapterOptions} from './adapter';

export const twilioModule: AdapterModule<TwilioAdapterOptions> = {
	name: 'twilio',

	parseConfig({options, allowedUserIds}) {
		const accountSid = options['account_sid'];
		if (typeof accountSid !== 'string') {
			return {ok: false, reason: 'account_sid required'};
		}
		const tokenEnv = options['auth_token_env'];
		if (typeof tokenEnv !== 'string') {
			return {ok: false, reason: 'auth_token_env required'};
		}
		const authToken = process.env[tokenEnv];
		if (!authToken) {
			return {ok: false, reason: `env var ${tokenEnv} unset`};
		}
		const fromNumber = options['from_number'];
		if (typeof fromNumber !== 'string') {
			return {ok: false, reason: 'from_number required'};
		}
		return {
			ok: true,
			config: {accountSid, authToken, fromNumber, allowedUserIds},
		};
	},

	create(config) {
		return new TwilioAdapter(config);
	},
};
```

`parseConfig` is pure validation — no I/O. Return descriptive `reason` strings; the gateway logs them on startup so the operator can fix the config.

### 4. Register the module

Add to `src/gateway/adapters/registry.ts`:

```ts
import {twilioModule} from './twilio/module';

export const BUILTIN_MODULES: ReadonlyArray<AdapterModule> = [
	telegramModule,
	twilioModule,
];
```

That's the entire wiring change. The factory will pick up the new module, the daemon will load any `~/.config/athena/channels/twilio.json` sidecar on startup, and inbound messages will route through the same `Dispatcher` / `OutboundDispatcher` / inbound queue / outbox as Telegram.

### 5. Test

```ts
// adapter.test.ts
import {TwilioAdapter} from './adapter';

it('normalizes inbound SMS', async () => {
  const adapter = new TwilioAdapter({...});
  const inbound: unknown[] = [];
  await adapter.start({
    log: () => {},
    signal: new AbortController().signal,
    emitInbound: msg => inbound.push(msg),
    emitHealth: () => {},
  });
  // ... feed a fake update through your transport, assert inbound shape
});
```

For end-to-end coverage, look at `src/gateway/control/sessionFlow.test.ts` — it boots a real daemon over a tmpdir UDS with a `FakeAdapter` and exercises the full inbound → dispatch → reply round trip. Same harness works for any adapter.

## What the gateway gives you for free

- **Inbound dedup**: a 1024-entry idempotency-key window in `ChannelManager`
- **Inbound parking**: messages parked in `inbound_queue` when no Athena TUI is registered, drained FIFO on register
- **Outbound retry**: send failures parked in `channel_outbox` with exponential backoff (1s → 30s, max 10 attempts), restart-safe
- **Sidecar loading**: discovery, mode-bit check, JSON parse, `allowed_user_ids` extraction
- **Routing**: `peer:thread > peer > room:thread > room > default` SessionKey ladder picks the right runtime session
- **Relay correlation**: when an adapter implements `requestPermissionVerdict`, `RelayCoordinator` handles the broadcast, claim, cancel, and TTL — adapters just race against an `AbortSignal`

## Reference contracts

- `src/shared/gateway-protocol/adapter.ts` — `ChannelAdapter`, `AdapterContext`, `AdapterModule`, capabilities, `StopReason`
- `src/shared/gateway-protocol/channel-events.ts` — `ChannelLocation`, `NormalizedInbound`, `OutboundMessage`, `peerLocation`, `roomLocation`
- `src/shared/gateway-protocol/relay.ts` — permission/question relay request/result types
- `src/gateway/adapters/telegram/` — full reference implementation
