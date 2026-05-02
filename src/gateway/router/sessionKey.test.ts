import {describe, expect, it} from 'vitest';
import {deriveSessionKey} from './sessionKey';

describe('deriveSessionKey', () => {
	it('peer + thread → peer:thread key', () => {
		expect(
			deriveSessionKey({
				channelId: 'telegram',
				accountId: 'a',
				peer: {id: '1', kind: 'user'},
				thread: {id: '7'},
			}),
		).toBe('peer:telegram:a:1:7');
	});

	it('peer without thread → peer key', () => {
		expect(
			deriveSessionKey({
				channelId: 'telegram',
				accountId: 'a',
				peer: {id: '1', kind: 'user'},
			}),
		).toBe('peer:telegram:a:1');
	});

	it('room + thread → room:thread key', () => {
		expect(
			deriveSessionKey({
				channelId: 'slack',
				accountId: 'a',
				room: {id: 'r1', kind: 'group'},
				thread: {id: 't1'},
			}),
		).toBe('room:slack:a:r1:t1');
	});

	it('room without thread → room key', () => {
		expect(
			deriveSessionKey({
				channelId: 'slack',
				accountId: 'a',
				room: {id: 'r1', kind: 'group'},
			}),
		).toBe('room:slack:a:r1');
	});

	it('falls back to default when no peer or room', () => {
		expect(
			deriveSessionKey({
				channelId: 'telegram',
				accountId: 'a',
			}),
		).toBe('default:telegram:a');
	});

	it('peer takes precedence over room when both are set', () => {
		expect(
			deriveSessionKey({
				channelId: 'telegram',
				accountId: 'a',
				peer: {id: '1', kind: 'user'},
				room: {id: 'r1', kind: 'group'},
			}),
		).toBe('peer:telegram:a:1');
	});
});
