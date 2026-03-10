import React from 'react';
import {describe, it, expect, vi} from 'vitest';
import {render} from 'ink-testing-library';
import QuestionDialog from './QuestionDialog';
import type {FeedEvent} from '../../core/feed/types';

function makeRequest(
	questions: Array<{
		question: string;
		header: string;
		options: Array<{label: string; description: string}>;
		multiSelect: boolean;
	}>,
): FeedEvent {
	return {
		event_id: 'test-q-1',
		seq: 1,
		ts: Date.now(),
		session_id: 's1',
		run_id: 's1:R1',
		kind: 'tool.pre',
		level: 'info',
		actor_id: 'agent:root',
		title: 'test',
		data: {
			tool_name: 'AskUserQuestion',
			tool_input: {questions},
		},
	} as FeedEvent;
}

describe('QuestionDialog', () => {
	it('renders question header and text', () => {
		const request = makeRequest([
			{
				question: 'Which library should we use?',
				header: 'Library',
				options: [
					{label: 'React', description: 'Popular UI library'},
					{label: 'Vue', description: 'Progressive framework'},
				],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('[Library]');
		expect(frame).toContain('Which library should we use?');
	});

	it('shows short option labels for all options', () => {
		const request = makeRequest([
			{
				question: 'Which library?',
				header: 'Library',
				options: [
					{label: 'React', description: 'Popular UI library'},
					{label: 'Vue', description: 'Progressive framework'},
				],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('React');
		expect(frame).toContain('Vue');
	});

	it('shows description only for focused option (first by default)', () => {
		const request = makeRequest([
			{
				question: 'Which library?',
				header: 'Library',
				options: [
					{label: 'React', description: 'Popular UI library'},
					{label: 'Vue', description: 'Progressive framework'},
				],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Popular UI library');
		expect(frame).not.toContain('Progressive framework');
	});

	it('renders Other option with clarifier description', () => {
		const request = makeRequest([
			{
				question: 'Which library?',
				header: 'Library',
				options: [{label: 'React', description: 'UI lib'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Other');
	});

	it('renders keybinding hints for single-select', () => {
		const request = makeRequest([
			{
				question: 'Question?',
				header: 'Q',
				options: [{label: 'A', description: 'desc'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Navigate');
		expect(frame).toContain('Select');
		expect(frame).toContain('Skip');
	});

	it('renders keybinding hints for multi-select', () => {
		const request = makeRequest([
			{
				question: 'Which features?',
				header: 'Features',
				options: [{label: 'Auth', description: 'Authentication'}],
				multiSelect: true,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Toggle');
		expect(frame).toContain('Submit');
	});

	it('shows tab headers when multiple questions', () => {
		const request = makeRequest([
			{
				question: 'First question?',
				header: 'Q1',
				options: [{label: 'A', description: 'Option A'}],
				multiSelect: false,
			},
			{
				question: 'Second question?',
				header: 'Q2',
				options: [{label: 'B', description: 'Option B'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('[1. Q1]');
		expect(frame).toContain('2. Q2');
	});

	it('does not show tabs for single question', () => {
		const request = makeRequest([
			{
				question: 'Only question?',
				header: 'Q',
				options: [{label: 'A', description: 'desc'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('1.');
	});

	it('shows queued count when more questions are queued', () => {
		const request = makeRequest([
			{
				question: 'Question?',
				header: 'Q',
				options: [{label: 'A', description: 'desc'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={2}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('(2 more queued)');
	});

	it('shows message when no questions found', () => {
		const request: FeedEvent = {
			event_id: 'test-q-empty',
			seq: 1,
			ts: Date.now(),
			session_id: 's1',
			run_id: 's1:R1',
			kind: 'tool.pre',
			level: 'info',
			actor_id: 'agent:root',
			title: 'test',
			data: {
				tool_name: 'AskUserQuestion',
				tool_input: {},
			},
		} as FeedEvent;

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('No questions found');
	});

	it('renders with themed horizontal rule separator instead of border', () => {
		const request = makeRequest([
			{
				question: 'Question?',
				header: 'Q',
				options: [{label: 'A', description: 'desc'}],
				multiSelect: false,
			},
		]);

		const {lastFrame} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('────');
		expect(frame).not.toContain('\u256d'); // no ╭
		expect(frame).not.toContain('\u256f'); // no ╯
	});

	it('calls onSkip when Esc is pressed', async () => {
		const onSkip = vi.fn();
		const request = makeRequest([
			{
				question: 'Question?',
				header: 'Q',
				options: [{label: 'A', description: 'desc'}],
				multiSelect: false,
			},
		]);

		const {stdin} = render(
			<QuestionDialog
				request={request}
				queuedCount={0}
				onAnswer={vi.fn()}
				onSkip={onSkip}
			/>,
		);

		stdin.write('\x1B');
		await new Promise(resolve => setImmediate(resolve));

		expect(onSkip).toHaveBeenCalled();
	});
});
