import {describe, it, expect, afterEach} from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {createClaudeHookRuntime} from '..';
import type {
	RuntimeEvent,
	RuntimeDecision,
} from '../../../../core/runtime/types';
import type {RuntimeConnector} from '../../../../core/runtime/connector';

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'athena-test-'));
}

describe('createClaudeHookRuntime', () => {
	let cleanup: (() => void)[] = [];

	afterEach(() => {
		cleanup.forEach(fn => fn());
		cleanup = [];
	});

	it('starts and reports running status', async () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 99});
		runtime.start();
		cleanup.push(() => runtime.stop());

		await new Promise(r => setTimeout(r, 100));
		expect(runtime.getStatus()).toBe('running');
		expect(runtime.getLastError()).toBeNull();
	});

	it('conforms to the transport-neutral runtime connector contract', () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		const runtime: RuntimeConnector = createClaudeHookRuntime({
			projectDir,
			instanceId: 95,
		});

		expect(typeof runtime.start).toBe('function');
		expect(typeof runtime.stop).toBe('function');
		expect(typeof runtime.getStatus).toBe('function');
		expect(typeof runtime.getLastError).toBe('function');
		expect(typeof runtime.onEvent).toBe('function');
		expect(typeof runtime.onDecision).toBe('function');
		expect(typeof runtime.sendDecision).toBe('function');
		expect(runtime.getStatus()).toBe('stopped');
	});

	it('emits RuntimeEvent when NDJSON arrives on socket', async () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 98});
		const events: RuntimeEvent[] = [];
		runtime.onEvent(e => events.push(e));
		runtime.start();
		cleanup.push(() => runtime.stop());

		await new Promise(r => setTimeout(r, 100));

		const sockPath = path.join(projectDir, '.claude', 'run', 'ink-98.sock');
		const client = net.createConnection(sockPath);
		await new Promise<void>(resolve => client.on('connect', resolve));

		const envelope = {
			request_id: 'r1',
			ts: Date.now(),
			session_id: 's1',
			hook_event_name: 'Notification',
			payload: {
				hook_event_name: 'Notification',
				session_id: 's1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				message: 'hello',
			},
		};
		client.write(JSON.stringify(envelope) + '\n');

		await new Promise(r => setTimeout(r, 200));
		expect(events).toHaveLength(1);
		expect(events[0]!.hookName).toBe('Notification');
		expect(events[0]!.id).toBe('r1');

		client.end();
	});

	it('sends HookResultEnvelope back when decision is provided', async () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 97});
		const events: RuntimeEvent[] = [];
		runtime.onEvent(e => events.push(e));
		runtime.start();
		cleanup.push(() => runtime.stop());

		await new Promise(r => setTimeout(r, 100));

		const sockPath = path.join(projectDir, '.claude', 'run', 'ink-97.sock');
		const client = net.createConnection(sockPath);
		await new Promise<void>(resolve => client.on('connect', resolve));

		const envelope = {
			request_id: 'r2',
			ts: Date.now(),
			session_id: 's1',
			hook_event_name: 'PermissionRequest',
			payload: {
				hook_event_name: 'PermissionRequest',
				session_id: 's1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				tool_name: 'Bash',
				tool_input: {command: 'rm -rf /'},
			},
		};
		client.write(JSON.stringify(envelope) + '\n');

		await new Promise(r => setTimeout(r, 200));
		expect(events).toHaveLength(1);

		// Collect response
		const responseData: string[] = [];
		client.on('data', chunk => responseData.push(chunk.toString()));

		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
		runtime.sendDecision('r2', decision);

		await new Promise(r => setTimeout(r, 200));
		expect(responseData.length).toBeGreaterThan(0);
		const result = JSON.parse(responseData.join('').trim());
		expect(result.request_id).toBe('r2');
		expect(result.payload.action).toBe('json_output');

		client.end();
	});

	it('cleans up stale socket files on start', async () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		// Create the run directory and plant a stale socket
		const runDir = path.join(projectDir, '.claude', 'run');
		fs.mkdirSync(runDir, {recursive: true});
		const staleSock = path.join(runDir, 'ink-999999999.sock');
		fs.writeFileSync(staleSock, '');

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 77});
		runtime.start();
		cleanup.push(() => runtime.stop());

		await new Promise(r => setTimeout(r, 100));

		// Stale socket should be gone; only the new one should remain
		const remaining = fs.readdirSync(runDir);
		expect(remaining).toEqual(['ink-77.sock']);
		expect(fs.existsSync(staleSock)).toBe(false);
	});

	it('stops cleanly', async () => {
		const projectDir = makeTmpDir();
		cleanup.push(() => fs.rmSync(projectDir, {recursive: true, force: true}));

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 96});
		runtime.start();
		await new Promise(r => setTimeout(r, 100));
		runtime.stop();
		expect(runtime.getStatus()).toBe('stopped');
		expect(runtime.getLastError()).toBeNull();
	});

	it('records a startup error when the socket path is too long', () => {
		const repeated = 'a'.repeat(120);
		const projectDir = path.join(makeTmpDir(), repeated);
		cleanup.push(() =>
			fs.rmSync(path.dirname(projectDir), {recursive: true, force: true}),
		);

		const runtime = createClaudeHookRuntime({projectDir, instanceId: 55});
		runtime.start();

		expect(runtime.getStatus()).toBe('stopped');
		expect(runtime.getLastError()).toEqual({
			code: 'socket_path_too_long',
			message: expect.stringContaining('Socket path is too long'),
		});
	});
});
