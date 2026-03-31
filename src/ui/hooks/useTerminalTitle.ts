import {useEffect, useRef} from 'react';
import {useStdout} from 'ink';

/**
 * Write terminal title escape sequences.
 * OSC 0 = window title, OSC 1 = tab/icon title, OSC 2 = window-only title.
 * Apple Terminal uses OSC 1 for the tab label, so we set both.
 */
function writeTitle(stream: NodeJS.WriteStream, title: string): void {
	stream.write(`\x1b]1;${title}\x07\x1b]2;${title}\x07`);
}

/**
 * Sets the terminal tab/window title via OSC 1 + OSC 2.
 *
 * Format: `[* ]Athena[ - <workflowName>]`
 *   - Prefix `* ` appears while the harness is actively running.
 *   - Restores the empty title on unmount so the terminal resets.
 */
export function useTerminalTitle(
	workflowName: string | undefined,
	isHarnessRunning: boolean,
): void {
	const {stdout} = useStdout();

	const suffix = workflowName ? ` - ${workflowName}` : '';
	const title = `${isHarnessRunning ? '* ' : ''}Athena${suffix}`;

	// Track previous title to avoid redundant writes.
	const prevRef = useRef('');

	useEffect(() => {
		if (title === prevRef.current) return;
		prevRef.current = title;
		writeTitle(stdout, title);
	}, [stdout, title]);

	// Restore default title on unmount.
	useEffect(() => {
		return () => writeTitle(stdout, '');
	}, [stdout]);
}
