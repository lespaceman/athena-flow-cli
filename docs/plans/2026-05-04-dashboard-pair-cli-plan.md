# Dashboard Pair CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the CLI side of dashboard remote-instance pairing so the dashboard-generated `athena dashboard pair <token>` command actually pairs this machine, stores refresh credentials safely, and can maintain the existing instance WebSocket. The `drisp` bin is deferred — pairing rides on the existing `athena` / `athena-flow` entry points.

**Architecture:** Add a top-level `dashboard` command group beside `gateway` and `channel`. Pairing calls the dashboard Worker's existing `/api/instances/pair` and `/api/instances/refresh` endpoints, stores only the long-lived refresh credential under `~/.config/athena/dashboard.json` with mode `0600`, and mints short-lived access tokens only when connecting to dashboard sockets. Do not write 15-minute access tokens into channel sidecars; the console adapter follow-up must use the same refresh-backed auth helper before each broker connection.

**Tech Stack:** Node 20 global `fetch`, `ws`, existing meow CLI entrypoint, JSON config files under `~/.config/athena`, Vitest.

---

## Current Repo Facts

- Dashboard UI currently copies a pairing command, but the CLI package has no `dashboard` command. The `drisp` bin is deferred; this plan ships the command on the existing `athena` and `athena-flow` bins. The dashboard UI must be updated separately to copy `athena dashboard pair <token>`.
- Dashboard endpoints already exist:
  - `POST /api/instances/pair`
  - `POST /api/instances/refresh`
  - `GET /api/instances/:instanceId/socket`
- Pairing token creates a remote instance, not a runner binding. Console runner binding stays a follow-up command because the current pairing token does not carry `runnerId`.
- Dashboard access tokens expire after 15 minutes. Static sidecar `pairing_token` is not acceptable for long-lived console or instance sockets.

## Files

- Create: `src/app/entry/dashboardCommand.ts`
- Create: `src/app/entry/dashboardCommand.test.ts`
- Create: `src/infra/config/dashboardClient.ts`
- Create: `src/infra/config/dashboardClient.test.ts`
- Create: `src/app/dashboard/instanceSocketClient.ts`
- Create: `src/app/dashboard/instanceSocketClient.test.ts`
- Modify: `src/app/entry/cli.tsx`
- Modify: `package.json`
- Modify: `docs/guides/athena-console-channel.md`
- Modify later follow-up: `src/gateway/adapters/console/client.ts`, `src/gateway/adapters/console/types.ts`, `src/gateway/adapters/console/adapter.ts`

## Public CLI

```bash
athena dashboard pair <pairing-token> --url <dashboard-origin> [--name <machine-name>]
athena dashboard status [--json]
athena dashboard refresh [--json]
athena dashboard connect
athena dashboard unpair
```

The same commands also work through `athena-flow` (same bin target). The dedicated `drisp` bin is deferred and intentionally not added in this plan.

`--url` is required for the first implementation. A later dashboard-distributed installer can preconfigure the origin.

## Local Config Shape

Path: `~/.config/athena/dashboard.json`

```json
{
	"dashboardUrl": "https://dashboard.example.com",
	"instanceId": "j57...",
	"refreshToken": "refresh-token",
	"fingerprint": "sha-or-stable-host-fingerprint",
	"pairedAt": 1777830000000,
	"lastRefreshAt": 1777830100000
}
```

File mode must be `0600`; containing directory mode should be `0700` on non-Windows platforms.

---

### Task 1: Config Store

**Files:**

- Create: `src/infra/config/dashboardClient.ts`
- Create: `src/infra/config/dashboardClient.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests covering:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	readDashboardClientConfig,
	writeDashboardClientConfig,
	dashboardClientConfigPath,
	normalizeDashboardUrl,
} from './dashboardClient';

describe('dashboard client config', () => {
	const originalHome = os.homedir;
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('normalizes dashboard origins without preserving paths', () => {
		expect(normalizeDashboardUrl('https://example.com/app/instances')).toBe(
			'https://example.com',
		);
		expect(normalizeDashboardUrl('http://localhost:5173/')).toBe(
			'http://localhost:5173',
		);
	});

	it('rejects non-http dashboard urls', () => {
		expect(() => normalizeDashboardUrl('ws://localhost:5173')).toThrow(
			/dashboard url must use http:\/\/ or https:\/\//,
		);
	});

	it('writes and reads config under ~/.config/athena/dashboard.json', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dashboard-'));
		vi.spyOn(os, 'homedir').mockReturnValue(tmp);
		writeDashboardClientConfig({
			dashboardUrl: 'http://localhost:5173',
			instanceId: 'inst_1',
			refreshToken: 'refresh_1',
			fingerprint: 'fp_1',
			pairedAt: 123,
		});
		expect(readDashboardClientConfig()).toEqual({
			dashboardUrl: 'http://localhost:5173',
			instanceId: 'inst_1',
			refreshToken: 'refresh_1',
			fingerprint: 'fp_1',
			pairedAt: 123,
		});
		expect(dashboardClientConfigPath()).toBe(
			path.join(tmp, '.config', 'athena', 'dashboard.json'),
		);
	});
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/infra/config/dashboardClient.test.ts
```

Expected: fails because `dashboardClient.ts` does not exist.

- [ ] **Step 3: Implement config helpers**

Create `src/infra/config/dashboardClient.ts` with:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DashboardClientConfig = {
	dashboardUrl: string;
	instanceId: string;
	refreshToken: string;
	fingerprint: string;
	pairedAt: number;
	lastRefreshAt?: number;
};

export function dashboardClientConfigPath(home = os.homedir()): string {
	return path.join(home, '.config', 'athena', 'dashboard.json');
}

export function normalizeDashboardUrl(input: string): string {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error('dashboard url must be a valid URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('dashboard url must use http:// or https://');
	}
	return parsed.origin;
}

export function readDashboardClientConfig(
	configPath = dashboardClientConfigPath(),
): DashboardClientConfig | null {
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
		return parseDashboardClientConfig(raw);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

export function writeDashboardClientConfig(
	config: DashboardClientConfig,
	configPath = dashboardClientConfigPath(),
): void {
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
		encoding: 'utf-8',
		mode: 0o600,
	});
	if (process.platform !== 'win32') {
		fs.chmodSync(dir, 0o700);
		fs.chmodSync(configPath, 0o600);
	}
}

export function removeDashboardClientConfig(
	configPath = dashboardClientConfigPath(),
): void {
	try {
		fs.unlinkSync(configPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

function parseDashboardClientConfig(raw: unknown): DashboardClientConfig {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('dashboard config root must be an object');
	}
	const obj = raw as Record<string, unknown>;
	const required = [
		'dashboardUrl',
		'instanceId',
		'refreshToken',
		'fingerprint',
	];
	for (const key of required) {
		if (typeof obj[key] !== 'string' || obj[key].length === 0) {
			throw new Error(`dashboard config ${key} must be a non-empty string`);
		}
	}
	if (typeof obj['pairedAt'] !== 'number') {
		throw new Error('dashboard config pairedAt must be a number');
	}
	if (
		obj['lastRefreshAt'] !== undefined &&
		typeof obj['lastRefreshAt'] !== 'number'
	) {
		throw new Error('dashboard config lastRefreshAt must be a number');
	}
	return {
		dashboardUrl: obj['dashboardUrl'] as string,
		instanceId: obj['instanceId'] as string,
		refreshToken: obj['refreshToken'] as string,
		fingerprint: obj['fingerprint'] as string,
		pairedAt: obj['pairedAt'] as number,
		...(obj['lastRefreshAt'] !== undefined
			? {lastRefreshAt: obj['lastRefreshAt'] as number}
			: {}),
	};
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- src/infra/config/dashboardClient.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/infra/config/dashboardClient.ts src/infra/config/dashboardClient.test.ts
git commit -m "feat(dashboard): add client config store"
```

---

### Task 2: Pair And Refresh HTTP Client

**Files:**

- Create: `src/app/entry/dashboardCommand.ts`
- Create: `src/app/entry/dashboardCommand.test.ts`

- [ ] **Step 1: Write failing command tests**

Test these behaviors:

- `pair <token> --url <origin>` posts to `/api/instances/pair`.
- Pair request body includes `token`, `fingerprint`, `hostInfo`, and `capabilities`.
- Pair writes `dashboard.json` with `refreshToken`, `instanceId`, and normalized origin.
- `refresh` posts to `/api/instances/refresh`, rotates the stored refresh token, and never logs tokens in human output.
- `pair` returns usage when `--url` or token is missing.

Use dependency injection instead of real network:

```ts
const fetchMock = vi.fn().mockResolvedValue({
	ok: true,
	status: 200,
	json: async () => ({
		instanceId: 'inst_1',
		refreshToken: 'refresh_1',
		jti: 'jti_1',
	}),
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- src/app/entry/dashboardCommand.test.ts
```

Expected: fails because `dashboardCommand.ts` does not exist.

- [ ] **Step 3: Implement command core**

Create `runDashboardCommand(input, deps)` with this public shape:

```ts
export type DashboardCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	flags: {
		url?: string;
		name?: string;
		json?: boolean;
	};
};

export type DashboardCommandDeps = {
	fetch?: typeof fetch;
	now?: () => number;
	fingerprint?: () => string;
	hostInfo?: () => Record<string, unknown>;
	readConfig?: typeof readDashboardClientConfig;
	writeConfig?: typeof writeDashboardClientConfig;
	removeConfig?: typeof removeDashboardClientConfig;
	logOut?: (message: string) => void;
	logError?: (message: string) => void;
};
```

Implement subcommands:

- `pair <token> --url <origin> [--name <machine-name>]`
- `refresh [--json]`
- `status [--json]`
- `unpair`

Pair body:

```ts
{
	token,
	fingerprint,
	hostInfo: {
		hostname: os.hostname(),
		user: os.userInfo().username,
		platform: os.platform(),
		arch: os.arch(),
		name: input.flags.name ?? os.hostname(),
	},
	capabilities: {
		instanceSocket: true,
		consoleAdapter: true,
		version: packageVersion,
	},
}
```

Refresh body:

```ts
{
	refreshToken: config.refreshToken,
	fingerprint: config.fingerprint,
}
```

Human output:

```text
dashboard: paired instance inst_1
dashboard: refreshed access token for instance inst_1
dashboard: paired to https://example.com as inst_1
dashboard: unpaired
```

JSON output may include `accessToken` for `refresh --json`; human output must not print access or refresh tokens.

- [ ] **Step 4: Verify**

```bash
npm test -- src/app/entry/dashboardCommand.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/entry/dashboardCommand.ts src/app/entry/dashboardCommand.test.ts
git commit -m "feat(dashboard): add pair and refresh command"
```

---

### Task 3: Wire CLI Entrypoint

**Files:**

- Modify: `src/app/entry/cli.tsx`
- Modify: `src/app/entry/cli.exec.test.ts`

The `drisp` bin is deferred; `package.json` is intentionally not modified in this task. The dashboard command is reachable via the existing `athena` and `athena-flow` bins, which both point at `dist/cli.js`.

- [ ] **Step 1: Add failing entrypoint tests**

In `src/app/entry/cli.exec.test.ts`, add a test that invokes the CLI with:

```ts
['dashboard', 'pair', 'tok_1', '--url', 'http://localhost:5173'];
```

Mock `runDashboardCommand` and assert it receives:

```ts
{
	subcommand: 'pair',
	subcommandArgs: ['tok_1'],
	flags: {
		url: 'http://localhost:5173',
		name: undefined,
		json: false,
	},
}
```

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- src/app/entry/cli.exec.test.ts
```

Expected: fails because `dashboard` is unknown.

- [ ] **Step 3: Update CLI help, flags, and routing**

Modify `src/app/entry/cli.tsx`:

- Add `dashboard` to `KNOWN_COMMANDS`.
- Add help row: `dashboard <sub> Manage dashboard remote-instance pairing`.
- Add flags:
  - `url: { type: 'string' }`
  - `name: { type: 'string' }`
- Route:

```ts
if (command === 'dashboard') {
	const [subcommand = '', ...subcommandArgs] = commandArgs;
	await exitWith(
		await runDashboardCommand({
			subcommand,
			subcommandArgs,
			flags: {
				url: typeof cli.flags.url === 'string' ? cli.flags.url : undefined,
				name: typeof cli.flags.name === 'string' ? cli.flags.name : undefined,
				json: Boolean(cli.flags.json),
			},
		}),
	);
	return;
}
```

Do not modify `package.json` in this task. The `drisp` bin is deferred; the existing `athena` and `athena-flow` bins both point at `dist/cli.js` and will pick up the new subcommand automatically.

- [ ] **Step 4: Verify**

```bash
npm test -- src/app/entry/cli.exec.test.ts src/app/entry/dashboardCommand.test.ts
npm run build
node dist/cli.js dashboard --help || true
```

Expected: tests pass; `athena dashboard` is reachable via `dist/cli.js` without a new bin entry.

- [ ] **Step 5: Commit**

```bash
git add src/app/entry/cli.tsx src/app/entry/cli.exec.test.ts
git commit -m "feat(cli): wire dashboard command"
```

---

### Task 4: Instance WebSocket Client

**Files:**

- Create: `src/app/dashboard/instanceSocketClient.ts`
- Create: `src/app/dashboard/instanceSocketClient.test.ts`
- Modify: `src/app/entry/dashboardCommand.ts`
- Modify: `src/app/entry/dashboardCommand.test.ts`

- [ ] **Step 1: Write failing socket tests**

Test:

- `dashboardUrl` `https://example.com` maps to `wss://example.com/api/instances/inst_1/socket`.
- `dashboardUrl` `http://localhost:5173` maps to `ws://localhost:5173/api/instances/inst_1/socket`.
- Client sends `{type:"ping",ts}` every heartbeat interval.
- On `job_assignment`, the client sends `{type:"assignment_accepted",runId}`.
- `connect` obtains a fresh access token through the refresh helper before opening the socket.

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- src/app/dashboard/instanceSocketClient.test.ts
```

Expected: fails because file does not exist.

- [ ] **Step 3: Implement socket client**

Create a small WS wrapper using `ws`:

```ts
export type InstanceSocketFrame =
	| {type: 'ping'; ts: number}
	| {type: 'pong'; ts: number}
	| {type: 'job_assignment'; runId: string; runSpec: unknown}
	| {type: 'assignment_accepted'; runId: string}
	| {type: 'cancel'; runId: string}
	| {type: 'error'; code: string};

export function instanceSocketUrl(
	dashboardUrl: string,
	instanceId: string,
): string {
	const url = new URL(dashboardUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/instances/${encodeURIComponent(instanceId)}/socket`;
	url.search = '';
	return url.toString();
}
```

The first implementation only needs to keep the socket alive, ack assignments, and log received assignments. It must not execute remote runs yet unless the dashboard run assignment protocol is fully mapped in a separate plan.

- [ ] **Step 4: Add `dashboard connect`**

Modify `runDashboardCommand` so `dashboard connect`:

- reads `dashboard.json`
- calls refresh to get access token
- opens the instance socket
- prints `dashboard: connected instance <id>`
- runs until SIGINT/SIGTERM

- [ ] **Step 5: Verify**

```bash
npm test -- src/app/dashboard/instanceSocketClient.test.ts src/app/entry/dashboardCommand.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/instanceSocketClient.ts src/app/dashboard/instanceSocketClient.test.ts src/app/entry/dashboardCommand.ts src/app/entry/dashboardCommand.test.ts
git commit -m "feat(dashboard): add instance socket connect"
```

---

### Task 5: Console Adapter Auth Follow-Up

**Files:**

- Modify: `src/gateway/adapters/console/types.ts`
- Modify: `src/gateway/adapters/console/client.ts`
- Modify: `src/gateway/adapters/console/adapter.ts`
- Modify: `src/gateway/adapters/console/client.test.ts`
- Modify: `src/gateway/adapters/console/module.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving:

- Console broker client can accept `pairingTokenProvider: () => Promise<string>`.
- Provider is called before initial connect.
- Provider is called again before reconnect.
- Token is sent only in the `Authorization` header.
- Errors redact the provider-returned token.

- [ ] **Step 2: Implement token provider**

Change `ConsoleBrokerClientOptions` from static-only token to:

```ts
pairingToken?: string;
pairingTokenProvider?: () => Promise<string>;
```

Require exactly one of the two.

- [ ] **Step 3: Add dashboard config mode to console sidecar**

Extend console sidecar parser to allow:

```json
{
	"broker_url": "wss://dashboard.example.com/api/runners/runner_1/console/adapter",
	"runner_id": "runner_1",
	"dashboard_config": true
}
```

When `dashboard_config` is true, the adapter reads `~/.config/athena/dashboard.json` and refreshes an access token before each broker connection.

- [ ] **Step 4: Verify**

```bash
npm test -- src/gateway/adapters/console
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/adapters/console
git commit -m "feat(console): use dashboard refresh token for broker auth"
```

---

### Task 6: Documentation And Smoke Test

**Files:**

- Modify: `docs/guides/athena-console-channel.md`
- Modify: `docs/guides/remote-gateway.md`

- [ ] **Step 1: Update docs**

Document:

```bash
athena dashboard pair <token> --url https://dashboard.example.com
athena dashboard status
athena dashboard connect
```

Also document local dev:

```bash
athena dashboard pair <token> --url http://localhost:5173
```

State clearly:

- pair token is one-time and short-lived
- refresh token is stored locally in `~/.config/athena/dashboard.json`
- access tokens are short-lived and minted on demand
- console runner binding is separate from machine pairing
- the dedicated `drisp` bin is deferred; `athena` and `athena-flow` are the supported entry points for now

- [ ] **Step 2: Verify command help**

```bash
npm run build
node dist/cli.js --help
node dist/cli.js dashboard
```

Expected: help lists `dashboard`; `dashboard` without subcommand prints dashboard usage.

- [ ] **Step 3: Manual smoke against dashboard dev**

In dashboard repo:

```bash
npm run dev
```

In CLI repo:

```bash
node dist/cli.js dashboard pair <fresh-token> --url http://localhost:5173
node dist/cli.js dashboard status
node dist/cli.js dashboard refresh --json
```

Expected:

- pair creates/updates `~/.config/athena/dashboard.json`
- status prints instance id and origin but no tokens
- refresh JSON includes `accessToken`, `refreshToken`, `instanceId`, `expiresInSec`
- human output never prints refresh token

- [ ] **Step 4: Final gates**

```bash
npm run typecheck
npm run lint:eslint
npm test
npm run build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/guides/athena-console-channel.md docs/guides/remote-gateway.md
git commit -m "docs(dashboard): document pairing command"
```

---

## Self-Review

- Spec coverage: implements the missing user-facing `athena dashboard pair <token>` path, stores refresh credentials, supports token refresh, and prepares the console adapter for expiring dashboard access tokens.
- Placeholder scan: no `TODO`, `TBD`, or fake file paths remain. Two scopes are explicitly deferred: (a) the `drisp` bin alias, which can be added later without rework by appending to `package.json` `bin`, and (b) remote run execution over `job_assignment`, which needs its own protocol mapping.
- Type consistency: `DashboardClientConfig`, `runDashboardCommand`, `instanceSocketUrl`, and `pairingTokenProvider` names are stable across tasks.
- Entry-point check: no task adds or assumes a `drisp` bin. All command examples and tests use `athena` / `athena-flow`. Dashboard UI copy update (separate repo) tracks alongside this plan.

## Recommended Execution Order

Implement Tasks 1-3 first as the minimal useful pairing feature. Task 4 makes the paired instance visible as a live socket client. Task 5 should land before dashboard Console production use, because static access tokens will expire and break reconnects. The `drisp` bin alias can be added in a follow-up once the surface is validated under `athena dashboard`.
