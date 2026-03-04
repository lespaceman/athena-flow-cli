import {useMemo} from 'react';
import type {InputMode} from './types';

const INPUT_PREFIX = 'input> ';

export function deriveInputPlaceholder(
	inputMode: InputMode,
	lastRunStatus: string | null,
): string {
	if (inputMode === 'search') return '/search';
	if (lastRunStatus === 'completed') return 'Run complete - type a follow-up';
	if (lastRunStatus === 'failed' || lastRunStatus === 'aborted')
		return 'Run failed - type a follow-up';
	return 'Type a prompt or /command';
}

export function deriveTextInputPlaceholder(
	dialogActive: boolean,
	dialogType: string | undefined,
	inputPlaceholder: string,
): string {
	if (!dialogActive) return inputPlaceholder;
	if (dialogType === 'question') return 'Answer question in dialog...';
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
	dialogActive: boolean;
	dialogType: string | undefined;
}): InputLayoutResult {
	const {
		innerWidth,
		inputMode,
		isHarnessRunning,
		lastRunStatus,
		dialogActive,
		dialogType,
	} = opts;

	return useMemo(() => {
		const runBadge = isHarnessRunning ? '[RUN]' : '[IDLE]';
		const modeBadges = [
			runBadge,
			...(inputMode === 'search' ? ['[SEARCH]'] : []),
		];
		const badgeText = modeBadges.join('');
		const inputContentWidth = Math.max(
			1,
			innerWidth - INPUT_PREFIX.length - badgeText.length,
		);
		const inputPlaceholder = deriveInputPlaceholder(inputMode, lastRunStatus);
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
		dialogActive,
		dialogType,
	]);
}
