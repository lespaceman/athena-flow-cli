/**
 * @vitest-environment jsdom
 */
import React, {createRef} from 'react';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {render} from 'ink-testing-library';
import * as registry from '../../app/commands/registry';
import {ShellInput, type ShellInputHandle} from './ShellInput';

const noop = () => {};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function renderShellInput(ref = createRef<ShellInputHandle>()) {
	return {
		ref,
		...render(
			<ShellInput
				ref={ref}
				innerWidth={60}
				useAscii={false}
				borderColor="#666666"
				inputRows={1}
				inputPrefix="›"
				inputPromptStyled="›"
				inputContentWidth={56}
				textInputPlaceholder="/command"
				textColor="#ffffff"
				inputPlaceholderColor="#999999"
				inputBackground="#101418"
				isInputActive={true}
				onChange={noop}
				onSubmit={noop}
				onHistoryBack={() => undefined}
				onHistoryForward={() => undefined}
				suppressArrows={true}
				setValueRef={noop}
				border={(text: string) => text}
				bottomBorder="└────────────────────────────────────────────────────────────┘"
				commandSuggestionsEnabled={true}
				wrapSuggestionLine={(line: string) => line}
			/>,
		),
	};
}

describe('ShellInput', () => {
	beforeEach(() => {
		registry.clear();
		registry.register({
			name: 'help',
			description: 'Show help',
			category: 'ui',
			execute: noop,
		});
		registry.register({
			name: 'clear',
			description: 'Clear screen',
			category: 'ui',
			execute: noop,
		});
		registry.register({
			name: 'commit',
			description: 'Commit changes',
			category: 'prompt',
			session: 'new',
			buildPrompt: () => 'commit',
		});
	});

	afterEach(() => {
		registry.clear();
	});

	it('shows command suggestions while typing a slash prefix', async () => {
		const {stdin, lastFrame} = renderShellInput();

		stdin.write('/');
		await delay(50);

		const output = lastFrame() ?? '';
		expect(output).toContain('/help');
		expect(output).toContain('/clear');
		expect(output).toContain('/commit');
	});

	it('shows command suggestions after the parent flips into command mode', async () => {
		function Harness() {
			const [commandSuggestionsEnabled, setCommandSuggestionsEnabled] =
				React.useState(false);

			return (
				<ShellInput
					innerWidth={60}
					useAscii={false}
					borderColor="#666666"
					inputRows={1}
					inputPrefix="›"
					inputPromptStyled="›"
					inputContentWidth={56}
					textInputPlaceholder="/command"
					textColor="#ffffff"
					inputPlaceholderColor="#999999"
					inputBackground="#101418"
					isInputActive={true}
					onChange={value => {
						setCommandSuggestionsEnabled(value.startsWith('/'));
					}}
					onSubmit={noop}
					onHistoryBack={() => undefined}
					onHistoryForward={() => undefined}
					suppressArrows={commandSuggestionsEnabled}
					setValueRef={noop}
					border={(text: string) => text}
					bottomBorder="└────────────────────────────────────────────────────────────┘"
					commandSuggestionsEnabled={commandSuggestionsEnabled}
					wrapSuggestionLine={(line: string) => line}
				/>
			);
		}

		const {stdin, lastFrame} = render(<Harness />);

		stdin.write('/');
		await delay(50);

		const output = lastFrame() ?? '';
		expect(output).toContain('/help');
		expect(output).toContain('/clear');
		expect(output).toContain('/commit');
	});

	it('filters commands from the local input value', async () => {
		const {stdin, lastFrame} = renderShellInput();

		stdin.write('/c');
		await delay(50);

		const output = lastFrame() ?? '';
		expect(output).toContain('/clear');
		expect(output).toContain('/commit');
		expect(output).not.toContain('/help');
	});

	it('exposes selected command navigation through the ref handle', async () => {
		const {stdin, ref} = renderShellInput();

		stdin.write('/');
		await delay(50);

		expect(ref.current?.getSelectedCommand()?.name).toBe('help');
		ref.current?.moveDown();
		await delay(20);
		expect(ref.current?.getSelectedCommand()?.name).toBe('clear');
	});

	it('keeps recalled slash history entries out of command suggestion mode', async () => {
		const onHistoryBack = vi
			.fn()
			.mockReturnValueOnce('/clear')
			.mockReturnValueOnce('plain prompt');
		const {stdin, lastFrame} = render(
			<ShellInput
				innerWidth={60}
				useAscii={false}
				borderColor="#666666"
				inputRows={1}
				inputPrefix="›"
				inputPromptStyled="›"
				inputContentWidth={56}
				textInputPlaceholder="/command"
				textColor="#ffffff"
				inputPlaceholderColor="#999999"
				inputBackground="#101418"
				isInputActive={true}
				onChange={noop}
				onSubmit={noop}
				onHistoryBack={onHistoryBack}
				onHistoryForward={() => undefined}
				suppressArrows={true}
				setValueRef={noop}
				border={(text: string) => text}
				bottomBorder="└────────────────────────────────────────────────────────────┘"
				commandSuggestionsEnabled={true}
				wrapSuggestionLine={(line: string) => line}
			/>,
		);

		stdin.write('x');
		await delay(50);
		stdin.write('\x1B[A');
		await delay(50);

		expect(onHistoryBack).toHaveBeenNthCalledWith(1, 'x');
		expect(lastFrame() ?? '').toContain('/clear');
		expect(lastFrame() ?? '').not.toContain('/help');

		stdin.write('\x1B[A');
		await delay(50);

		expect(onHistoryBack).toHaveBeenNthCalledWith(2, '/clear');
		expect(lastFrame() ?? '').toContain('plain prompt');
	});
});
