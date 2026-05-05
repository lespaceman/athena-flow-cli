import crypto from 'node:crypto';
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

export function dashboardClientConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const home = env['HOME'] ?? os.homedir();
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
	env: NodeJS.ProcessEnv = process.env,
): DashboardClientConfig | null {
	const configPath = dashboardClientConfigPath(env);
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`dashboard client config ${configPath} is invalid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	try {
		return parseDashboardClientConfig(parsed);
	} catch (err) {
		throw new Error(
			`dashboard client config ${configPath} is invalid: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

export function writeDashboardClientConfig(
	config: DashboardClientConfig,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const validated = parseDashboardClientConfig(config);
	const configPath = dashboardClientConfigPath(env);
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	// Atomic write: stage to a sibling tempfile, fsync, then rename. A crash
	// mid-write leaves either the previous content intact (rename never ran)
	// or the new content in full. Without this, a concurrent crash could
	// truncate the file and orphan the pairing.
	const tmpPath = `${configPath}.${process.pid}.${crypto
		.randomBytes(4)
		.toString('hex')}.tmp`;
	const fd = fs.openSync(tmpPath, 'w', 0o600);
	try {
		fs.writeSync(fd, JSON.stringify(validated, null, 2) + '\n');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmpPath, configPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup; original error is what matters
		}
		throw err;
	}
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(dir, 0o700);
			fs.chmodSync(configPath, 0o600);
		} catch {
			// best-effort
		}
	}
}

export function removeDashboardClientConfig(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const configPath = dashboardClientConfigPath(env);
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
	const stringFields: Array<keyof DashboardClientConfig> = [
		'dashboardUrl',
		'instanceId',
		'refreshToken',
		'fingerprint',
	];
	for (const key of stringFields) {
		const value = obj[key];
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error(`${key} must be a non-empty string`);
		}
	}
	if (typeof obj['pairedAt'] !== 'number') {
		throw new Error('pairedAt must be a number');
	}
	if (
		obj['lastRefreshAt'] !== undefined &&
		typeof obj['lastRefreshAt'] !== 'number'
	) {
		throw new Error('lastRefreshAt must be a number');
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
