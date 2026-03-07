import {useRef, useEffect} from 'react';
import {useInput} from 'ink';
import {evaluateEscapeInterruptGate} from './escapeInterruptGate';
import {startInputMeasure} from '../../shared/utils/perf';
import type {FocusMode, InputMode} from './types';

type CommandSuggestionCallbacks = {
	moveUp: () => void;
	moveDown: () => void;
	tab: () => void;
	visible: () => boolean;
};

type GlobalKeyboardCallbacks = {
	interrupt: () => void;
	cycleFocus: () => void;
	cancelInput: () => void;
	cycleHintsForced: () => void;
	toggleTodoVisible: () => void;
	historyBack: (current: string) => string | undefined;
	historyForward: () => string | undefined;
	getInputValue: () => string;
	setInputValue: (value: string) => void;
	commandSuggestions?: CommandSuggestionCallbacks;
	inputMode?: InputMode;
};

type GlobalKeyboardOptions = {
	isActive: boolean;
	isHarnessRunning: boolean;
	focusMode: FocusMode;
	dialogActive: boolean;
	callbacks: GlobalKeyboardCallbacks;
};

export function useGlobalKeyboard({
	isActive,
	isHarnessRunning,
	focusMode,
	dialogActive,
	callbacks,
}: GlobalKeyboardOptions): void {
	const interruptEscapeAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!isHarnessRunning || focusMode !== 'feed') {
			interruptEscapeAtRef.current = null;
		}
	}, [isHarnessRunning, focusMode]);

	useInput(
		(input, key) => {
			const done = startInputMeasure('app.global', input, key);
			try {
				if (dialogActive) return;

				const interruptGate = evaluateEscapeInterruptGate({
					keyEscape: key.escape,
					isHarnessRunning,
					focusMode,
					lastEscapeAtMs: interruptEscapeAtRef.current,
					nowMs: Date.now(),
				});
				interruptEscapeAtRef.current = interruptGate.nextLastEscapeAtMs;
				if (interruptGate.shouldInterrupt) {
					callbacks.interrupt();
					return;
				}
				if (key.ctrl && input === 't') {
					callbacks.toggleTodoVisible();
					return;
				}
				if (key.ctrl && input === '/') {
					callbacks.cycleHintsForced();
					return;
				}
				if (focusMode === 'input') {
					// Command suggestion navigation (must come before Tab/arrow handlers)
					const cs = callbacks.commandSuggestions;
					if (callbacks.inputMode === 'command' && cs?.visible()) {
						if (key.upArrow) {
							cs.moveUp();
							return;
						}
						if (key.downArrow) {
							cs.moveDown();
							return;
						}
						if (key.tab) {
							cs.tab();
							return;
						}
					}

					if (key.escape) {
						callbacks.cancelInput();
						return;
					}
					if (key.tab) {
						callbacks.cycleFocus();
						return;
					}
					if (key.ctrl && input === 'p') {
						const prev = callbacks.historyBack(callbacks.getInputValue());
						if (prev !== undefined) callbacks.setInputValue(prev);
						return;
					}
					if (key.ctrl && input === 'n') {
						const next = callbacks.historyForward();
						if (next !== undefined) callbacks.setInputValue(next);
						return;
					}
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
