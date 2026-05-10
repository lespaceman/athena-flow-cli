/**
 * Reader for `~/.config/athena/channels/*.json` sidecars.
 *
 * The gateway daemon calls `loadChannelSidecars()` on startup and instantiates
 * one adapter per file. The same path layout was previously written by the
 * legacy `athena channel telegram configure` command, so existing user
 * configs continue to work after the gateway-resident adapters land.
 *
 * Validation is intentionally permissive — unknown keys flow through as
 * adapter options. Strict zod schemas live next to each adapter and reject
 * invalid configs at construction time.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ChannelSidecar = {
	/**
	 * Filename stem (no .json). Historically also the routing key into the
	 * adapter registry — preserved for diagnostics. New sidecars should set
	 * `kind` explicitly so the routing key is independent of the filename.
	 */
	name: string;
	path: string;
	/**
	 * Adapter module to instantiate (e.g. "console", "telegram"). Defaults to
	 * `name` when the sidecar omits it, preserving backward compatibility for
	 * single-instance configs like `console.json`.
	 */
	kind: string;
	/**
	 * Stable identity reported by the resulting adapter — must be unique
	 * across all loaded sidecars (ChannelManager rejects duplicates).
	 * Defaults to `kind` when omitted, so `console.json` continues to load
	 * with `id="console"`. Multi-instance configs (e.g. one console per
	 * runner) set this to a unique value like `"console:<runnerId>"`.
	 */
	instanceId: string;
	/**
	 * Optional dashboard-side **Attachment** key (today: runnerId). Present
	 * iff the sidecar carries a top-level `runner_id`. Surfaces here so the
	 * gateway daemon can wire each adapter to its attachment slot in the
	 * DispatchPipeline. See ADR 0001 phase 5.
	 */
	attachmentId?: string;
	allowedUserIds: string[];
	options: Record<string, unknown>;
};

export type LoadSidecarsResult = {
	sidecars: ChannelSidecar[];
	errors: Array<{path: string; reason: string}>;
};

export function channelSidecarDir(home: string = os.homedir()): string {
	return path.join(home, '.config', 'athena', 'channels');
}

export function loadChannelSidecars(
	home: string = os.homedir(),
): LoadSidecarsResult {
	const dir = channelSidecarDir(home);
	const sidecars: ChannelSidecar[] = [];
	const errors: LoadSidecarsResult['errors'] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return {sidecars, errors};
		errors.push({
			path: dir,
			reason: `read dir failed: ${err instanceof Error ? err.message : String(err)}`,
		});
		return {sidecars, errors};
	}
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue;
		const full = path.join(dir, entry);
		const name = entry.slice(0, -'.json'.length);
		const result = loadOne(name, full);
		if (result.ok) sidecars.push(result.sidecar);
		else errors.push({path: full, reason: result.reason});
	}
	return {sidecars, errors};
}

type LoadOne =
	| {ok: true; sidecar: ChannelSidecar}
	| {ok: false; reason: string};

function loadOne(name: string, filePath: string): LoadOne {
	let raw: unknown;
	try {
		if (process.platform !== 'win32') {
			const stat = fs.statSync(filePath);
			if ((stat.mode & 0o077) !== 0) {
				return {
					ok: false,
					reason: `file ${filePath} is too permissive (mode ${(stat.mode & 0o777).toString(8)}); chmod 600`,
				};
			}
		}
		raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
	if (typeof raw !== 'object' || raw === null) {
		return {ok: false, reason: 'config root must be an object'};
	}
	const obj = raw as Record<string, unknown>;
	const userIdsRaw = obj['allowed_user_ids'];
	const allowedUserIds: string[] = [];
	if (userIdsRaw !== undefined) {
		if (!Array.isArray(userIdsRaw)) {
			return {ok: false, reason: 'allowed_user_ids must be an array'};
		}
		for (const id of userIdsRaw) {
			if (typeof id === 'string') allowedUserIds.push(id);
			else if (typeof id === 'number') allowedUserIds.push(String(id));
			else
				return {
					ok: false,
					reason: 'allowed_user_ids entries must be string or number',
				};
		}
	}
	const kindRaw = obj['kind'];
	if (
		kindRaw !== undefined &&
		(typeof kindRaw !== 'string' || kindRaw.length === 0)
	) {
		return {ok: false, reason: 'kind must be a non-empty string'};
	}
	const kind = (kindRaw as string | undefined) ?? name;
	const instanceIdRaw = obj['instance_id'];
	if (
		instanceIdRaw !== undefined &&
		(typeof instanceIdRaw !== 'string' || instanceIdRaw.length === 0)
	) {
		return {ok: false, reason: 'instance_id must be a non-empty string'};
	}
	const instanceId = (instanceIdRaw as string | undefined) ?? kind;
	const runnerIdRaw = obj['runner_id'];
	let attachmentId: string | undefined;
	if (runnerIdRaw !== undefined) {
		if (typeof runnerIdRaw !== 'string' || runnerIdRaw.length === 0) {
			return {ok: false, reason: 'runner_id must be a non-empty string'};
		}
		attachmentId = runnerIdRaw;
	}
	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === 'allowed_user_ids' || key === 'kind' || key === 'instance_id') {
			continue;
		}
		options[key] = value;
	}
	const sidecar: ChannelSidecar = {
		name,
		path: filePath,
		kind,
		instanceId,
		allowedUserIds,
		options,
	};
	if (attachmentId !== undefined) sidecar.attachmentId = attachmentId;
	return {ok: true, sidecar};
}
