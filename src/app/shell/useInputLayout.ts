import {useMemo} from 'react';
import type {InputMode} from './types';

const INPUT_PREFIX = '›';
const INPUT_SIDE_PADDING = 3;

export function deriveInputPlaceholder(
	inputMode: InputMode,
	_lastRunStatus: string | null,
	startupFailureMessage?: string | null,
	_ascii = false,
): string {
	if (inputMode === 'search') return ':search';
	if (inputMode === 'command') return '/command';
	if (startupFailureMessage) return 'Write a message';
	return 'Write a message';
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
		lastRunStatus,
		startupFailureMessage,
		dialogActive,
		dialogType,
		ascii,
	} = opts;

	return useMemo(() => {
		const inputContentWidth = Math.max(
			1,
			innerWidth - INPUT_PREFIX.length - INPUT_SIDE_PADDING,
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
			inputContentWidth,
			textInputPlaceholder,
		};
	}, [
		innerWidth,
		inputMode,
		lastRunStatus,
		startupFailureMessage,
		dialogActive,
		dialogType,
		ascii,
	]);
}
