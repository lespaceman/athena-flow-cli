import {describe, it, expect} from 'vitest';
import {isResponse, isNotification, isServerRequest} from '../jsonrpc';

describe('JSON-RPC message classification', () => {
	it('identifies responses', () => {
		expect(isResponse({id: 1, result: {}})).toBe(true);
		expect(isResponse({id: 1, error: {code: -1, message: 'err'}})).toBe(true);
		expect(isResponse({method: 'foo', id: 1})).toBe(false);
	});

	it('identifies notifications', () => {
		expect(isNotification({method: 'turn/started', params: {}})).toBe(true);
		expect(isNotification({method: 'foo', id: 1})).toBe(false);
	});

	it('identifies server requests', () => {
		expect(
			isServerRequest({method: 'item/commandExecution/requestApproval', id: 5}),
		).toBe(true);
		expect(isServerRequest({method: 'foo'})).toBe(false);
	});
});
