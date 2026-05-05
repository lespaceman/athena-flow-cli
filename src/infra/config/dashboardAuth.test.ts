import {describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {refreshDashboardAccessToken} from './dashboardAuth';
import {
	readDashboardClientConfig,
	writeDashboardClientConfig,
} from './dashboardClient';

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function withTempHome() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-auth-'));
	return {HOME: home};
}

describe('refreshDashboardAccessToken', () => {
	it('throws when not paired', async () => {
		const env = withTempHome();
		await expect(refreshDashboardAccessToken({env})).rejects.toThrow(
			/not paired/,
		);
	});

	it('posts refreshToken+fingerprint, rotates stored refresh token, returns access token', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'old-refresh',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);

		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				accessToken: 'fresh-access',
				refreshToken: 'rotated-refresh',
				expiresInSec: 900,
			}),
		);

		const result = await refreshDashboardAccessToken({
			env,
			fetch: fetchMock as unknown as typeof fetch,
			now: () => 5_000,
		});

		expect(result).toEqual({
			accessToken: 'fresh-access',
			instanceId: 'inst_1',
			expiresInSec: 900,
		});
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://example.com/api/instances/refresh');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			refreshToken: 'old-refresh',
			fingerprint: 'fp-1',
		});

		const stored = readDashboardClientConfig(env);
		expect(stored?.refreshToken).toBe('rotated-refresh');
		expect(stored?.lastRefreshAt).toBe(5_000);
	});

	it('throws on non-2xx and never leaks refresh token in the message', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'super-secret-refresh',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);

		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(401, {error: 'expired'}));
		await expect(
			refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({
			message: expect.stringMatching(/401/),
		});

		try {
			await refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
			});
		} catch (err) {
			expect((err as Error).message).not.toContain('super-secret-refresh');
		}
	});

	it('does not echo response body for 401/403 (refresh-token reflection guard)', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'super-secret-refresh',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);
		// Server reflects the request body, including the refresh token.
		const reflectedBody = JSON.stringify({
			error: 'invalid_token',
			received: {refreshToken: 'super-secret-refresh', fingerprint: 'fp-1'},
		});
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => reflectedBody,
			json: async () => JSON.parse(reflectedBody),
		} as unknown as Response);

		try {
			await refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error('expected refresh to fail');
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toMatch(/401/);
			expect(msg).not.toContain('super-secret-refresh');
		}
	});

	it('serializes concurrent refresh calls via the on-disk lock', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'r0',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);

		let counter = 0;
		const seenTokens: string[] = [];
		const fetchMock = vi
			.fn()
			.mockImplementation(async (_url: string, init: RequestInit) => {
				const body = JSON.parse(init.body as string) as {refreshToken: string};
				seenTokens.push(body.refreshToken);
				// Force interleaving by yielding before responding.
				await new Promise(r => setTimeout(r, 5));
				counter += 1;
				return jsonResponse(200, {
					instanceId: 'inst_1',
					accessToken: `access-${counter}`,
					refreshToken: `r${counter}`,
					expiresInSec: 900,
				});
			});

		const [a, b] = await Promise.all([
			refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
				lockTimeoutMs: 2_000,
				lockPollMs: 5,
			}),
			refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
				lockTimeoutMs: 2_000,
				lockPollMs: 5,
			}),
		]);

		// Both calls succeeded → neither saw the burned token. The second
		// call must have read the rotated value written by the first.
		expect(seenTokens).toEqual(['r0', 'r1']);
		expect([a.accessToken, b.accessToken].sort()).toEqual([
			'access-1',
			'access-2',
		]);
	});

	it('reaps a stale lock file', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'r0',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);
		// Plant a stale lock with a deliberately old mtime.
		const configPath = path.join(
			env.HOME!,
			'.config',
			'athena',
			'dashboard.json',
		);
		const lockPath = `${configPath}.lock`;
		fs.writeFileSync(lockPath, '');
		const oldMtime = new Date(Date.now() - 120_000);
		fs.utimesSync(lockPath, oldMtime, oldMtime);

		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				accessToken: 'access-1',
				refreshToken: 'r1',
				expiresInSec: 900,
			}),
		);
		const result = await refreshDashboardAccessToken({
			env,
			fetch: fetchMock as unknown as typeof fetch,
			staleLockMs: 30_000,
			lockTimeoutMs: 200,
		});
		expect(result.accessToken).toBe('access-1');
	});

	it('throws when fetch rejects with a connection error', async () => {
		const env = withTempHome();
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_1',
				refreshToken: 'r',
				fingerprint: 'fp-1',
				pairedAt: 1,
			},
			env,
		);

		const fetchMock = vi.fn().mockRejectedValue(new Error('econnrefused'));
		await expect(
			refreshDashboardAccessToken({
				env,
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow(/failed to reach https:\/\/example\.com.*econnrefused/);
	});
});
