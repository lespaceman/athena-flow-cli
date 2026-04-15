import {useInput} from 'ink';
import {type MessageTab} from '../../core/feed/panelFilter';
import {startInputMeasure} from '../../shared/utils/perf';

export type MessageKeyboardCallbacks = {
	moveMessageCursor: (delta: number) => void;
	jumpToTail: () => void;
	jumpToTop: () => void;
	expandAtCursor: () => void;
	cycleFocus: () => void;
	openCommandInput: () => void;
	openSearchInput: () => void;
	setInputValue: (value: string) => void;
	setMessageTab: (tab: MessageTab) => void;
};

export type MessageKeyboardOptions = {
	isActive: boolean;
	pageStep: number;
	callbacks: MessageKeyboardCallbacks;
};

export function useMessageKeyboard({
	isActive,
	pageStep,
	callbacks,
}: MessageKeyboardOptions): void {
	useInput(
		(input, key) => {
			const done = startInputMeasure('message.keyboard', input, key);
			try {
				if (key.tab) {
					callbacks.cycleFocus();
					return;
				}

				if (input === '/') {
					callbacks.openCommandInput();
					callbacks.setInputValue('/');
					return;
				}

				if (input === ':') {
					callbacks.openSearchInput();
					callbacks.setInputValue(':');
					return;
				}

				if (input === 'u' || input === 'U') {
					callbacks.setMessageTab('user');
					return;
				}
				if (input === 'a' || input === 'A') {
					callbacks.setMessageTab('agent');
					return;
				}
				if (input === 'b' || input === 'B') {
					callbacks.setMessageTab('both');
					return;
				}

				if (key.home || input === 'g') {
					callbacks.jumpToTop();
					return;
				}
				if (key.end || input === 'G') {
					callbacks.jumpToTail();
					return;
				}
				if (key.pageUp) {
					callbacks.moveMessageCursor(-pageStep);
					return;
				}
				if (key.pageDown) {
					callbacks.moveMessageCursor(pageStep);
					return;
				}
				if (key.upArrow) {
					callbacks.moveMessageCursor(-1);
					return;
				}
				if (key.downArrow) {
					callbacks.moveMessageCursor(1);
					return;
				}

				if (key.return || (key.ctrl && key.rightArrow)) {
					callbacks.expandAtCursor();
					return;
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
