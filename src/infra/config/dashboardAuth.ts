import fs from 'node:fs';
import {
	type DashboardClientConfig,
	dashboardClientConfigPath,
	readDashboardClientConfig,
	writeDashboardClientConfig,
} from './dashboardClient';

export type DashboardAccessToken = {
	accessToken: string;
	instanceId: string;
	expiresInSec: number;
};

export type RefreshDashboardAccessTokenDeps = {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	now?: () => number;
	/** Override lock-acquisition timeout (ms). Tests use small values. */
	lockTimeoutMs?: number;
	/**
	 * Override the polling interval when waiting for a lock (ms). Tests use
	 * small values; production callers should leave the default.
	 */
	lockPollMs?: number;
	/**
	 * If a lock file is older than this (ms) it is treated as stale and
	 * forcibly removed. Default 60s — long enough that a healthy refresh
	 * round-trip never trips it, short enough that a crashed process
	 * doesn't permanently wedge the user.
	 */
	staleLockMs?: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 60_000;

/**
 * Reads the dashboard client config, posts to /api/instances/refresh, rotates
 * the stored refresh token, and returns the short-lived access token.
 *
 * Throws if not paired or if refresh fails. The error message does not
 * include the refresh or access token.
 */
export async function refreshDashboardAccessToken(
	deps: RefreshDashboardAccessTokenDeps = {},
): Promise<DashboardAccessToken> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => Date.now());

	// Fail fast outside the lock when no pairing exists — the lock file
	// would land in a directory that doesn't exist yet.
	const initial = readDashboardClientConfig(env);
	if (!initial) {
		throw new Error(
			'dashboard not paired. Run "athena dashboard pair <token> --url <origin>" first.',
		);
	}

	// Refresh tokens are single-use: the server burns the old token when it
	// issues a new one. Without serialization, two concurrent CLI components
	// (the `dashboard connect` command and the console adapter, say) can both
	// read the same refresh token, post it, and the loser sees a 401 with no
	// hope of recovery. Hold an exclusive file lock around read-refresh-write
	// so callers serialize, then re-read so subsequent callers see the
	// rotated token.
	return await withLock(env, deps, async () => {
		const config = readDashboardClientConfig(env);
		if (!config) {
			throw new Error(
				'dashboard not paired. Run "athena dashboard pair <token> --url <origin>" first.',
			);
		}

		let response: Response;
		try {
			response = await fetchImpl(
				`${config.dashboardUrl}/api/instances/refresh`,
				{
					method: 'POST',
					headers: {'content-type': 'application/json'},
					body: JSON.stringify({
						refreshToken: config.refreshToken,
						fingerprint: config.fingerprint,
					}),
				},
			);
		} catch (err) {
			throw new Error(
				`dashboard refresh: failed to reach ${config.dashboardUrl}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		if (!response.ok) {
			// Some servers reflect the request body in error responses (e.g.
			// validation errors echoing fields). Drop the body on auth-failed
			// responses to avoid surfacing the refresh token in a thrown
			// `Error.message` that may end up in logs or exception traces.
			let detail = '';
			const dropBody = response.status === 401 || response.status === 403;
			if (!dropBody) {
				try {
					detail = await response.text();
				} catch {
					// best-effort
				}
			}
			throw new Error(
				`dashboard refresh: ${config.dashboardUrl} returned ${response.status}` +
					(detail ? ` — ${truncate(detail, 200)}` : ''),
			);
		}

		let parsed: DashboardAccessToken & {refreshToken: string};
		try {
			parsed = parseRefreshResponse(await response.json());
		} catch (err) {
			throw new Error(
				`dashboard refresh: invalid response: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		const updated: DashboardClientConfig = {
			...config,
			refreshToken: parsed.refreshToken,
			lastRefreshAt: now(),
		};
		writeDashboardClientConfig(updated, env);

		return {
			accessToken: parsed.accessToken,
			instanceId: parsed.instanceId,
			expiresInSec: parsed.expiresInSec,
		};
	});
}

async function withLock<T>(
	env: NodeJS.ProcessEnv,
	deps: RefreshDashboardAccessTokenDeps,
	fn: () => Promise<T>,
): Promise<T> {
	const configPath = dashboardClientConfigPath(env);
	const lockPath = `${configPath}.lock`;
	const timeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const pollMs = deps.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
	const staleMs = deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

	const deadline = Date.now() + timeoutMs;
	let fd: number | null = null;
	for (;;) {
		try {
			fd = fs.openSync(lockPath, 'wx', 0o600);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			// Lock exists. Reap if stale.
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > staleMs) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch {
				// Lock disappeared between EEXIST and stat — retry the open.
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`dashboard refresh: timed out waiting for ${lockPath} after ${timeoutMs}ms`,
				);
			}
			await new Promise<void>(resolve => setTimeout(resolve, pollMs));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// best-effort
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// best-effort
		}
	}
}

function parseRefreshResponse(
	raw: unknown,
): DashboardAccessToken & {refreshToken: string} {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('expected object');
	}
	const obj = raw as Record<string, unknown>;
	const accessToken = obj['accessToken'];
	const refreshToken = obj['refreshToken'];
	const instanceId = obj['instanceId'];
	const expiresInSec = obj['expiresInSec'];
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		throw new Error('missing accessToken');
	}
	if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
		throw new Error('missing refreshToken');
	}
	if (typeof instanceId !== 'string' || instanceId.length === 0) {
		throw new Error('missing instanceId');
	}
	if (typeof expiresInSec !== 'number') {
		throw new Error('missing expiresInSec');
	}
	return {accessToken, refreshToken, instanceId, expiresInSec};
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}
