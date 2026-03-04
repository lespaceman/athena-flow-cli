type FocusMode = 'feed' | 'input' | 'todo';

export const DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS = 900;

export type EscapeInterruptGateInput = {
	keyEscape: boolean;
	isHarnessRunning: boolean;
	focusMode: FocusMode;
	lastEscapeAtMs: number | null;
	nowMs: number;
};

export type EscapeInterruptGateResult = {
	shouldInterrupt: boolean;
	nextLastEscapeAtMs: number | null;
};

export function evaluateEscapeInterruptGate(
	input: EscapeInterruptGateInput,
): EscapeInterruptGateResult {
	const canInterrupt = input.isHarnessRunning && input.focusMode === 'feed';

	if (!input.keyEscape || !canInterrupt) {
		return {shouldInterrupt: false, nextLastEscapeAtMs: null};
	}

	const isSecondEscape =
		input.lastEscapeAtMs !== null &&
		input.nowMs - input.lastEscapeAtMs <= DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS;

	if (isSecondEscape) {
		return {shouldInterrupt: true, nextLastEscapeAtMs: null};
	}

	return {shouldInterrupt: false, nextLastEscapeAtMs: input.nowMs};
}
