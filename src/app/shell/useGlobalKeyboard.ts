import {useRef, useEffect} from 'react';
import {useInput} from 'ink';
import {evaluateEscapeInterruptGate} from './escapeInterruptGate';
import {startInputMeasure} from '../../shared/utils/perf';
import type {FocusMode, InputMode} from './types';

type GlobalKeyboardCallbacks = {
	interrupt: () => void;
	cycleFocus: () => void;
	setFocusMode: (mode: FocusMode) => void;
	setInputMode: (mode: InputMode) => void;
	setHintsForced: React.Dispatch<React.SetStateAction<boolean | null>>;
	setTodoVisible: (fn: (prev: boolean) => boolean) => void;
	historyBack: (current: string) => string | undefined;
	historyForward: () => string | undefined;
	getInputValue: () => string;
	setInputValue: (value: string) => void;
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
					callbacks.setTodoVisible(v => !v);
					if (focusMode === 'todo') callbacks.setFocusMode('feed');
					return;
				}
				if (key.ctrl && input === '/') {
					callbacks.setHintsForced(prev =>
						prev === null ? true : prev ? false : null,
					);
					return;
				}
				if (focusMode === 'input') {
					if (key.escape) {
						callbacks.setFocusMode('feed');
						callbacks.setInputMode('normal');
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
