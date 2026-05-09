import {describe, it, expect} from 'vitest';
import {createDecisionCorrelation} from './decisionCorrelation';

describe('decisionCorrelation', () => {
	it('returns null when consuming an unknown request_id', () => {
		const dc = createDecisionCorrelation();
		expect(dc.consumeForDecision('missing')).toBeNull();
	});

	it('looks up a recorded request by id and returns parent + kind on consume', () => {
		const dc = createDecisionCorrelation();
		dc.recordRequest('req-1', 'evt-1', 'permission.request');
		expect(dc.consumeForDecision('req-1')).toEqual({
			parentEventId: 'evt-1',
			originalKind: 'permission.request',
		});
	});

	it('consume is single-shot — a second consume returns null', () => {
		const dc = createDecisionCorrelation();
		dc.recordRequest('req-1', 'evt-1', 'permission.request');
		dc.consumeForDecision('req-1');
		expect(dc.consumeForDecision('req-1')).toBeNull();
	});

	it('lookupResolved survives consume', () => {
		const dc = createDecisionCorrelation();
		dc.recordRequest('req-1', 'evt-1', 'permission.request');
		dc.consumeForDecision('req-1');
		expect(dc.lookupResolved('req-1')).toEqual({
			event_id: 'evt-1',
			kind: 'permission.request',
		});
	});

	it('lookupResolved returns null for unknown request', () => {
		const dc = createDecisionCorrelation();
		expect(dc.lookupResolved('missing')).toBeNull();
	});

	it('resetForNewRun clears both consumeable and resolved indexes', () => {
		const dc = createDecisionCorrelation();
		dc.recordRequest('req-1', 'evt-1', 'permission.request');
		dc.resetForNewRun();
		expect(dc.consumeForDecision('req-1')).toBeNull();
		expect(dc.lookupResolved('req-1')).toBeNull();
	});
});
