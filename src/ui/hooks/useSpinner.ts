import {useState, useEffect} from 'react';
import {startPerfCycle} from '../../shared/utils/perf';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEFAULT_SPINNER_INTERVAL_MS = 1000;

/**
 * Hook that returns an animated braille spinner character.
 * Cycles through frames when active, returns '' when inactive.
 */
export function useSpinner(
	active: boolean,
	intervalMs = DEFAULT_SPINNER_INTERVAL_MS,
): string {
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		if (!active) {
			setFrameIndex(0);
			return;
		}

		const timer = setInterval(() => {
			startPerfCycle('timer:spinner', {scope: 'spinner'});
			setFrameIndex(i => (i + 1) % BRAILLE_FRAMES.length);
		}, intervalMs);

		return () => clearInterval(timer);
	}, [active, intervalMs]);

	if (!active) return '';
	return BRAILLE_FRAMES[frameIndex] ?? '⠋';
}
