/**
 * @vitest-environment jsdom
 */
import React from 'react';
import {describe, it, expect, vi} from 'vitest';
import {render} from 'ink-testing-library';
import {MultiLineInput} from './MultiLineInput';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe('MultiLineInput', () => {
	it('renders placeholder when empty', () => {
		const {lastFrame} = render(
			<MultiLineInput width={30} placeholder="Type here..." isActive={false} />,
		);
		expect(lastFrame()).toContain('Type here...');
	});

	it('calls onChange when user types', async () => {
		const onChange = vi.fn();
		const {stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onChange={onChange}
			/>,
		);

		stdin.write('hi');
		await delay(50);

		expect(onChange).toHaveBeenCalledWith('hi');
	});

	it('calls onSubmit when Enter is pressed', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onSubmit={onSubmit}
			/>,
		);

		stdin.write('hello');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		expect(onSubmit).toHaveBeenCalledWith('hello');
	});

	it('backslash+Enter inserts newline instead of submitting', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onSubmit={onSubmit}
			/>,
		);

		stdin.write('hello\\');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('calls onHistoryBack when Up is pressed on first visual line', async () => {
		const onHistoryBack = vi.fn().mockReturnValue('recalled');
		const {lastFrame, stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onHistoryBack={onHistoryBack}
			/>,
		);

		stdin.write('test');
		await delay(50);
		// Up arrow on first (and only) line
		stdin.write('\x1b[A');
		await delay(50);

		expect(onHistoryBack).toHaveBeenCalledWith('test');
		expect(lastFrame()).toContain('recalled');
	});

	it('calls onHistoryForward when Down is pressed on last visual line', async () => {
		const onHistoryForward = vi.fn().mockReturnValue('next');
		const {lastFrame, stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onHistoryForward={onHistoryForward}
			/>,
		);

		stdin.write('test');
		await delay(50);
		// Down arrow on last (and only) line
		stdin.write('\x1b[B');
		await delay(50);

		expect(onHistoryForward).toHaveBeenCalled();
		expect(lastFrame()).toContain('next');
	});

	it('exposes setValue via setValueRef for programmatic updates', async () => {
		let setValueFn: ((v: string) => void) | null = null;
		const {lastFrame} = render(
			<MultiLineInput
				width={30}
				placeholder="empty"
				isActive={true}
				setValueRef={fn => {
					setValueFn = fn;
				}}
			/>,
		);

		expect(setValueFn).not.toBeNull();
		// Use ink's act equivalent — direct call since render is synchronous in tests
		setValueFn!('programmatic');
		await delay(50);

		expect(lastFrame()).toContain('programmatic');
	});

	it('does not receive input when isActive is false', async () => {
		const onChange = vi.fn();
		const {stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={false}
				onChange={onChange}
			/>,
		);

		stdin.write('hello');
		await delay(50);

		expect(onChange).not.toHaveBeenCalled();
	});

	it('handles multi-character paste as single insert', async () => {
		const onChange = vi.fn();
		const {lastFrame, stdin} = render(
			<MultiLineInput
				width={30}
				placeholder=""
				isActive={true}
				onChange={onChange}
			/>,
		);

		// Simulate paste by writing a multi-char string at once
		stdin.write('pasted text');
		await delay(50);

		expect(lastFrame()).toContain('pasted text');
	});
});
