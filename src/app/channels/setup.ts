/**
 * App-layer wiring for the channels subsystem.
 *
 * Resolves channel names (e.g. "telegram") to a `ChannelDefinition` by:
 *   - locating the built-in channel entry script under `dist/`
 *   - loading and validating the sidecar config from `~/.config/athena/channels/<name>.json`
 *
 * Channel resolution is fail-soft: an unknown name or a missing/invalid
 * sidecar yields a structured failure that callers can surface as a feed
 * error without blocking session start.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadChannelConfig} from '../../channels/config';
import {TELEGRAM_CHANNEL_NAME} from '../../channels/telegram/name';
import type {ChannelDefinition} from '../../channels/types';

export type ChannelResolutionResult =
	| {ok: true; definition: ChannelDefinition}
	| {ok: false; name: string; reason: string};

const BUILTIN_ENTRY_FILES: Record<string, string> = {
	[TELEGRAM_CHANNEL_NAME]: 'channel-telegram.js',
};

const BUILTIN_DAEMON_ENTRY_FILE = 'channel-daemon.js';

const distDirCache = new Map<string, string>();

/**
 * Locate the directory containing `entryFile` (a sibling of the running
 * CLI). The bundled CLI loads as `dist/cli.js`, so the caller's
 * `import.meta.url` already points into `dist/`; in practice the first
 * candidate matches. We still fall back to a bounded upward walk for dev
 * scenarios (tests, ts-node) where the running file lives outside `dist/`.
 *
 * Anchoring on `entryFile` itself (not on `cli.js`) avoids matching an
 * unrelated ancestor `dist/cli.js` in monorepos.
 */
function findDistDir(meta: ImportMeta, entryFile: string): string | null {
	const cached = distDirCache.get(entryFile);
	if (cached !== undefined) return cached;
	let current: string;
	try {
		current = path.dirname(fileURLToPath(meta.url));
	} catch {
		return null;
	}
	if (fs.existsSync(path.join(current, entryFile))) {
		distDirCache.set(entryFile, current);
		return current;
	}
	for (let i = 0; i < 6; i++) {
		const candidates = [current, path.join(current, 'dist')];
		for (const candidate of candidates) {
			if (fs.existsSync(path.join(candidate, entryFile))) {
				distDirCache.set(entryFile, candidate);
				return candidate;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

export function resolveChannel(
	name: string,
	meta: ImportMeta = import.meta,
): ChannelResolutionResult {
	const entryFile = BUILTIN_ENTRY_FILES[name];
	if (!entryFile) {
		return {ok: false, name, reason: `unknown channel: ${name}`};
	}

	const distDir = findDistDir(meta, entryFile);
	if (!distDir) {
		return {
			ok: false,
			name,
			reason: `channel entry not found in dist: ${entryFile}`,
		};
	}

	const entryPath = path.join(distDir, entryFile);
	const daemonEntryPath = path.join(distDir, BUILTIN_DAEMON_ENTRY_FILE);
	if (!fs.existsSync(daemonEntryPath)) {
		return {
			ok: false,
			name,
			reason: `channel daemon entry not found in dist: ${BUILTIN_DAEMON_ENTRY_FILE}`,
		};
	}

	const sidecar = loadChannelConfig(name);
	if (!sidecar.ok) {
		return {ok: false, name, reason: sidecar.reason};
	}

	return {
		ok: true,
		definition: {
			name,
			entryPath,
			daemonEntryPath,
			args: [entryPath],
			allowedUserIds: sidecar.config.allowed_user_ids,
			options: sidecar.config.options,
		},
	};
}

export function resolveChannels(
	names: readonly string[],
	meta: ImportMeta = import.meta,
): {
	definitions: ChannelDefinition[];
	failures: Array<{name: string; reason: string}>;
} {
	const definitions: ChannelDefinition[] = [];
	const failures: Array<{name: string; reason: string}> = [];
	for (const name of names) {
		const result = resolveChannel(name, meta);
		if (result.ok) definitions.push(result.definition);
		else failures.push({name: result.name, reason: result.reason});
	}
	return {definitions, failures};
}
