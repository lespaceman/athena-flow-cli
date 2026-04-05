import {describe, it, expect} from 'vitest';
import {substituteVariables} from './templateVars';

describe('substituteVariables', () => {
	it('substitutes {input}', () => {
		expect(substituteVariables('Execute: {input}', {input: 'ship it'})).toBe(
			'Execute: ship it',
		);
	});

	it('substitutes {sessionId} and <session_id>', () => {
		const text = 'Path: .athena/{sessionId}/tracker.md and <session_id>';
		expect(substituteVariables(text, {sessionId: 'abc-123'})).toBe(
			'Path: .athena/abc-123/tracker.md and abc-123',
		);
	});

	it('substitutes {trackerPath}', () => {
		expect(
			substituteVariables('Read {trackerPath}', {
				trackerPath: '.athena/abc/tracker.md',
			}),
		).toBe('Read .athena/abc/tracker.md');
	});

	it('substitutes all variables together', () => {
		const text = '{input} at {trackerPath} in {sessionId}';
		expect(
			substituteVariables(text, {
				input: 'hello',
				sessionId: 's1',
				trackerPath: '/t.md',
			}),
		).toBe('hello at /t.md in s1');
	});

	it('replaces all occurrences of each variable', () => {
		expect(
			substituteVariables('{sessionId} and {sessionId}', {sessionId: 'x'}),
		).toBe('x and x');
	});

	it('leaves text unchanged when context fields are undefined', () => {
		expect(substituteVariables('{input} {sessionId}', {})).toBe(
			'{input} {sessionId}',
		);
	});
});
