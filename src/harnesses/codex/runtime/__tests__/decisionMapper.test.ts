import {describe, it, expect} from 'vitest';
import {mapDecisionToCodexResult} from '../decisionMapper';
import type {
	RuntimeEvent,
	RuntimeDecision,
} from '../../../../core/runtime/types';
import * as M from '../../protocol/methods';

const MOCK_EVENT: RuntimeEvent = {
	id: 'codex-req-5',
	timestamp: Date.now(),
	kind: 'permission.request',
	data: {tool_name: 'command_execution'},
	hookName: 'item/commandExecution/requestApproval',
	sessionId: 'test',
	context: {cwd: '/tmp', transcriptPath: ''},
	interaction: {
		expectsDecision: true,
		defaultTimeoutMs: 300000,
		canBlock: true,
	},
	payload: {},
};

const MOCK_QUESTION_EVENT: RuntimeEvent = {
	...MOCK_EVENT,
	hookName: M.TOOL_REQUEST_USER_INPUT,
	data: {tool_name: 'user_input'},
};

describe('mapDecisionToCodexResult', () => {
	it('maps passthrough to accept', () => {
		const decision: RuntimeDecision = {type: 'passthrough', source: 'timeout'};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'accept',
		});
	});

	it('maps block to decline', () => {
		const decision: RuntimeDecision = {
			type: 'block',
			source: 'user',
			reason: 'dangerous',
		};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'decline',
		});
	});

	it('maps permission_allow intent to accept', () => {
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'accept',
		});
	});

	it('maps permission_deny intent to decline', () => {
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_deny', reason: 'nope'},
		};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'decline',
		});
	});

	it('maps question_answer to answers object', () => {
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'question_answer', answers: {q1: 'a1'}},
		};
		expect(mapDecisionToCodexResult(MOCK_QUESTION_EVENT, decision)).toEqual({
			answers: {q1: {answers: ['a1']}},
		});
	});

	it('maps stop_block to cancel', () => {
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'stop_block', reason: 'user stopped'},
		};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'cancel',
		});
	});

	it('maps json without intent to accept', () => {
		const decision: RuntimeDecision = {type: 'json', source: 'rule'};
		expect(mapDecisionToCodexResult(MOCK_EVENT, decision)).toEqual({
			decision: 'accept',
		});
	});
});
