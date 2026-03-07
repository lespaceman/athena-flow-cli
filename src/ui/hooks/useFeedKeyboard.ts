import {useInput} from 'ink';
import {startInputMeasure} from '../../shared/utils/perf';

export type FeedKeyboardCallbacks = {
	moveFeedCursor: (delta: number) => void;
	jumpToTail: () => void;
	jumpToTop: () => void;
	expandAtCursor: () => void;
	yankAtCursor: () => void;
	cycleFocus: () => void;
	openCommandInput: () => void;
	openSearchInput: () => void;
	setInputValue: (value: string) => void;
	hideRunOverlay: () => void;
	stepSearchMatch: (direction: 1 | -1, matches: number[]) => void;
	clearSearchAndJumpTail: () => void;
};

export type FeedKeyboardOptions = {
	isActive: boolean;
	pageStep: number;
	searchMatches: number[];
	callbacks: FeedKeyboardCallbacks;
};

export function useFeedKeyboard({
	isActive,
	pageStep,
	searchMatches,
	callbacks,
}: FeedKeyboardOptions): void {
	useInput(
		(input, key) => {
			const done = startInputMeasure('feed.keyboard', input, key);
			try {
				// Escape
				if (key.escape) {
					callbacks.hideRunOverlay();
					return;
				}

				// Feed navigation mode
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

				if (key.home) {
					callbacks.jumpToTop();
					return;
				}
				if (key.end) {
					callbacks.jumpToTail();
					return;
				}
				if (key.pageUp) {
					callbacks.moveFeedCursor(-pageStep);
					return;
				}
				if (key.pageDown) {
					callbacks.moveFeedCursor(pageStep);
					return;
				}
				if (key.upArrow) {
					callbacks.moveFeedCursor(-1);
					return;
				}
				if (key.downArrow) {
					callbacks.moveFeedCursor(1);
					return;
				}

				if (key.return || (key.ctrl && key.rightArrow)) {
					callbacks.expandAtCursor();
					return;
				}

				if (input === 'y' || input === 'Y') {
					callbacks.yankAtCursor();
					return;
				}

				if ((input === 'n' || input === 'N') && searchMatches.length > 0) {
					callbacks.stepSearchMatch(input === 'n' ? 1 : -1, searchMatches);
					return;
				}

				if (key.ctrl && input === 'l') {
					callbacks.clearSearchAndJumpTail();
					return;
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
