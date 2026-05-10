import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {channelSidecarDir, loadChannelSidecars} from './channels';

function writeSidecar(home: string, name: string, body: object): string {
	const dir = channelSidecarDir(home);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	const file = path.join(dir, `${name}.json`);
	fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', {mode: 0o600});
	return file;
}

describe('loadChannelSidecars', () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-sidecar-test-'));
	});
	afterEach(() => {
		try {
			fs.rmSync(home, {recursive: true, force: true});
		} catch {
			// best-effort
		}
	});

	it('loads a console sidecar and exposes runner_id as attachmentId', () => {
		writeSidecar(home, 'console-r1', {
			kind: 'console',
			instance_id: 'console:r1',
			runner_id: 'r1',
			broker_url: 'wss://example/api/runners/r1/console/adapter',
			dashboard_config: true,
		});
		const {sidecars, errors} = loadChannelSidecars(home);
		expect(errors).toEqual([]);
		expect(sidecars).toHaveLength(1);
		expect(sidecars[0]?.instanceId).toBe('console:r1');
		expect(sidecars[0]?.attachmentId).toBe('r1');
	});

	it('returns attachmentId undefined when sidecar omits runner_id', () => {
		writeSidecar(home, 'console', {
			kind: 'console',
		});
		const {sidecars, errors} = loadChannelSidecars(home);
		expect(errors).toEqual([]);
		expect(sidecars).toHaveLength(1);
		expect(sidecars[0]?.attachmentId).toBeUndefined();
	});

	it('rejects sidecars whose runner_id is not a non-empty string', () => {
		writeSidecar(home, 'console-bad', {
			kind: 'console',
			instance_id: 'console:bad',
			runner_id: '',
		});
		const {sidecars, errors} = loadChannelSidecars(home);
		expect(sidecars).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.reason).toMatch(/runner_id/);
	});
});
