import {useMemo} from 'react';
import type {InputMode} from './types';

const INPUT_PREFIX = 'input> ';

export function deriveInputPlaceholder(
	inputMode: InputMode,
	lastRunStatus: string | null,
	startupFailureMessage?: string | null,
	ascii = false,
): string {
	const dash = ascii ? '-' : '\u2014';
	if (inputMode === 'search') return ':search';
	if (inputMode === 'command') return '/command';
	if (startupFailureMessage)
		return `Startup failed ${dash} fix issue and retry`;
	if (lastRunStatus === 'completed') return `Done ${dash} send a follow-up`;
	if (lastRunStatus === 'failed' || lastRunStatus === 'aborted')
		return `Run failed ${dash} retry or adjust prompt`;
	return 'Type a prompt to begin';
}

export function deriveTextInputPlaceholder(
	dialogActive: boolean,
	dialogType: string | undefined,
	inputPlaceholder: string,
): string {
	if (!dialogActive) return inputPlaceholder;
	if (dialogType === 'question') return 'Answer question in dialog...';
	if (dialogType === 'diagnostics') return 'Respond to diagnostics dialog...';
	return 'Respond to permission dialog...';
}

type InputLayoutResult = {
	inputPrefix: string;
	badgeText: string;
	inputContentWidth: number;
	textInputPlaceholder: string;
};

export function useInputLayout(opts: {
	innerWidth: number;
	inputMode: InputMode;
	isHarnessRunning: boolean;
	lastRunStatus: string | null;
	startupFailureMessage?: string | null;
	dialogActive: boolean;
	dialogType: string | undefined;
	ascii: boolean;
}): InputLayoutResult {
	const {
		innerWidth,
		inputMode,
		isHarnessRunning,
		lastRunStatus,
		startupFailureMessage,
		dialogActive,
		dialogType,
		ascii,
	} = opts;

	return useMemo(() => {
		const runBadge = startupFailureMessage
			? '[ERR]'
			: isHarnessRunning
				? '[RUN]'
				: '[IDLE]';
		const modeBadges = [
			runBadge,
			...(inputMode === 'search' ? ['[SEARCH]'] : []),
			...(inputMode === 'command' ? ['[CMD]'] : []),
		];
		const badgeText = modeBadges.join('');
		const inputContentWidth = Math.max(
			1,
			innerWidth - INPUT_PREFIX.length - badgeText.length,
		);
		const inputPlaceholder = deriveInputPlaceholder(
			inputMode,
			lastRunStatus,
			startupFailureMessage,
			ascii,
		);
		const textInputPlaceholder = deriveTextInputPlaceholder(
			dialogActive,
			dialogType,
			inputPlaceholder,
		);

		return {
			inputPrefix: INPUT_PREFIX,
			badgeText,
			inputContentWidth,
			textInputPlaceholder,
		};
	}, [
		innerWidth,
		inputMode,
		isHarnessRunning,
		lastRunStatus,
		startupFailureMessage,
		dialogActive,
		dialogType,
		ascii,
	]);
}
