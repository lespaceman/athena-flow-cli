import {describe, it, expect} from 'vitest';
import {createMockRuntime} from './scriptedReplay';
import {createInjectableMockRuntime} from './injectable';
import type {RuntimeEvent, RuntimeDecision} from '../../../core/runtime/types';

describe('createMockRuntime (scripted)', () => {
	it('emits scripted events after delay', async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createMockRuntime([
			{delayMs: 10, event: {hookName: 'SessionStart'}},
			{delayMs: 20, event: {hookName: 'PreToolUse', toolName: 'Bash'}},
		]);
		runtime.onEvent(e => events.push(e));
		await runtime.start();

		await new Promise(r => setTimeout(r, 100));
		expect(events).toHaveLength(2);
		expect(events[0]!.hookName).toBe('SessionStart');
		expect(events[1]!.toolName).toBe('Bash');

		runtime.stop();
	});

	it('stores decisions for inspection', async () => {
		const runtime = createMockRuntime([
			{
				delayMs: 10,
				event: {hookName: 'PermissionRequest', toolName: 'Bash'},
			},
		]);
		runtime.onEvent(() => {});
		await runtime.start();

		await new Promise(r => setTimeout(r, 50));
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
		runtime.sendDecision(runtime._getLastEventId(), decision);

		expect(runtime._getDecisions()).toHaveLength(1);

		runtime.stop();
	});
});

describe('createInjectableMockRuntime', () => {
	it('emits events programmatically', () => {
		const events: RuntimeEvent[] = [];
		const mock = createInjectableMockRuntime();
		mock.onEvent(e => events.push(e));
		void mock.start();

		mock.emit({hookName: 'PreToolUse', toolName: 'Read'});
		expect(events).toHaveLength(1);
		expect(events[0]!.toolName).toBe('Read');

		mock.stop();
	});

	it('captures decisions', () => {
		const mock = createInjectableMockRuntime();
		mock.onEvent(() => {});
		void mock.start();

		mock.emit({hookName: 'PermissionRequest', toolName: 'Bash'});
		mock.sendDecision(mock.getLastEventId(), {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		});

		expect(mock.getDecisions()).toHaveLength(1);
		expect(mock.getDecision(mock.getLastEventId())?.intent?.kind).toBe(
			'permission_allow',
		);

		mock.stop();
	});
});
