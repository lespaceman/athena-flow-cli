import {describe, expect, it} from 'vitest';

import {parseRunnerEnvelope} from './envelope';

describe('parseRunnerEnvelope', () => {
	it('parses a job_assignment envelope with runSpec', () => {
		const text = JSON.stringify({
			kind: 'job_assignment',
			runId: 'run-1',
			runSpec: {prompt: 'do the thing'},
		});
		expect(parseRunnerEnvelope(text)).toEqual({
			kind: 'job_assignment',
			runId: 'run-1',
			runSpec: {prompt: 'do the thing'},
		});
	});

	it('parses a job_assignment envelope without runSpec', () => {
		const text = JSON.stringify({kind: 'job_assignment', runId: 'run-2'});
		expect(parseRunnerEnvelope(text)).toEqual({
			kind: 'job_assignment',
			runId: 'run-2',
			runSpec: undefined,
		});
	});

	it('parses a cancel envelope', () => {
		const text = JSON.stringify({kind: 'cancel', runId: 'run-3'});
		expect(parseRunnerEnvelope(text)).toEqual({
			kind: 'cancel',
			runId: 'run-3',
		});
	});

	it('returns null for plain (non-JSON) text', () => {
		expect(parseRunnerEnvelope('hello world')).toBeNull();
	});

	it('returns null for JSON that is not a runner envelope', () => {
		expect(parseRunnerEnvelope(JSON.stringify({greeting: 'hi'}))).toBeNull();
	});

	it('returns null for a runner envelope with a missing runId', () => {
		const text = JSON.stringify({kind: 'job_assignment'});
		expect(parseRunnerEnvelope(text)).toBeNull();
	});

	it('returns null for an unknown envelope kind', () => {
		const text = JSON.stringify({kind: 'something_else', runId: 'r'});
		expect(parseRunnerEnvelope(text)).toBeNull();
	});

	it('returns null for non-object JSON (e.g. a number)', () => {
		expect(parseRunnerEnvelope('42')).toBeNull();
	});
});
