import {describe, expect, it} from 'vitest';
import {
	AlreadyRegisteredError,
	NotRegisteredError,
	SessionRegistry,
	UnknownDispatchError,
} from './sessionRegistry';

function makeRegistry() {
	let counter = 0;
	return new SessionRegistry({
		idFactory: () => `disp-${++counter}`,
		now: () => 1000 + counter,
	});
}

const dmLocation = {
	channelId: 'telegram',
	accountId: 'a',
	peer: {id: '1', kind: 'user' as const},
};

describe('SessionRegistry', () => {
	it('registers a runtime and returns the current registration', () => {
		const reg = makeRegistry();
		const r = reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		expect(r.runtimeId).toBe('r1');
		expect(reg.getCurrent()?.pid).toBe(99);
	});

	it('rejects a duplicate registration with AlreadyRegisteredError', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		expect(() =>
			reg.register({runtimeId: 'r2', defaultAgentId: 'main', pid: 100}),
		).toThrow(AlreadyRegisteredError);
	});

	it('allows re-register after unregister', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		reg.unregister('r1');
		expect(reg.getCurrent()).toBeNull();
		reg.register({runtimeId: 'r2', defaultAgentId: 'main', pid: 100});
		expect(reg.getCurrent()?.runtimeId).toBe('r2');
	});

	it('rejects unregister with the wrong runtimeId', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		expect(() => reg.unregister('rZ')).toThrow(NotRegisteredError);
	});

	it('refuses beginDispatch when no runtime is registered', () => {
		const reg = makeRegistry();
		expect(() =>
			reg.beginDispatch({
				sessionKey: 'k',
				agentId: 'main',
				location: dmLocation,
			}),
		).toThrow(NotRegisteredError);
	});

	it('parks and resolves dispatch entries in order', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		const e = reg.beginDispatch({
			sessionKey: 'peer:telegram:a:1',
			agentId: 'main',
			location: dmLocation,
		});
		expect(e.dispatchId).toBe('disp-1');
		expect(reg.pendingDispatchCount()).toBe(1);
		const completed = reg.completeDispatch('disp-1');
		expect(completed.location.peer?.id).toBe('1');
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('throws UnknownDispatchError for an unknown id', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		expect(() => reg.completeDispatch('missing')).toThrow(UnknownDispatchError);
	});

	it('clears parked dispatches on unregister', () => {
		const reg = makeRegistry();
		reg.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 99});
		reg.beginDispatch({
			sessionKey: 'k',
			agentId: 'main',
			location: dmLocation,
		});
		reg.unregister('r1');
		expect(reg.pendingDispatchCount()).toBe(0);
	});
});
