/**
 * Per-channel sidecar config loader.
 *
 * Channel configs live at `~/.config/athena/channels/<name>.json`.
 * Secrets must never leak into the main `config.json` (which may be
 * project-scoped and committed).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ChannelSidecarConfig = {
	allowed_user_ids: string[];
	options: Record<string, unknown>;
};

export type LoadResult =
	| {ok: true; config: ChannelSidecarConfig}
	| {ok: false; reason: string};

export function channelConfigDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'channels');
}

export function channelConfigPath(name: string): string {
	return path.join(channelConfigDir(), `${name}.json`);
}

export function channelStateDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'channel-state');
}

/**
 * Load and validate a channel sidecar. Returns a structured failure rather
 * than throwing — channel startup is fail-soft.
 *
 * On POSIX, the file's permissions must be 0600 or stricter. World/group-
 * readable secrets are refused.
 */
export function loadChannelConfig(name: string): LoadResult {
	const configPath = channelConfigPath(name);
	let raw: unknown;
	try {
		if (process.platform !== 'win32') {
			const stat = fs.statSync(configPath);
			// Refuse if any group/other bits are set (mode & 0o077 !== 0).
			if ((stat.mode & 0o077) !== 0) {
				return {
					ok: false,
					reason: `config file ${configPath} is too permissive (mode ${(stat.mode & 0o777).toString(8)}); chmod 600`,
				};
			}
		}
		raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return {ok: false, reason: `config not found: ${configPath}`};
		}
		return {
			ok: false,
			reason: `read error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (typeof raw !== 'object' || raw === null) {
		return {ok: false, reason: 'config root must be an object'};
	}

	const obj = raw as Record<string, unknown>;
	const userIdsRaw = obj['allowed_user_ids'];
	if (!Array.isArray(userIdsRaw)) {
		return {ok: false, reason: 'allowed_user_ids must be an array'};
	}
	const allowed_user_ids: string[] = [];
	for (const id of userIdsRaw) {
		if (typeof id === 'string') allowed_user_ids.push(id);
		else if (typeof id === 'number') allowed_user_ids.push(String(id));
		else
			return {
				ok: false,
				reason: 'allowed_user_ids entries must be string or number',
			};
	}

	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === 'allowed_user_ids') continue;
		options[key] = value;
	}

	return {ok: true, config: {allowed_user_ids, options}};
}
