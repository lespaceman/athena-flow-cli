/**
 * @vitest-environment jsdom
 */
import React, {createRef} from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
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
				inputPrefix="input> "
				inputPromptStyled="input> "
				inputContentWidth={46}
				textInputPlaceholder="/command"
				textColor="#ffffff"
				inputPlaceholderColor="#999999"
				isInputActive={true}
				onChange={noop}
				onSubmit={noop}
				onHistoryBack={() => undefined}
				onHistoryForward={() => undefined}
				suppressArrows={true}
				setValueRef={noop}
				badgeText="[IDLE][CMD]"
				runBadgeStyled=" RUN "
				modeBadgeStyled=" CMD "
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
});
