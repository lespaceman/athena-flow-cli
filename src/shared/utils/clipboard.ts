/**
 * Copy text to system clipboard via OSC 52 terminal escape sequence.
 * Works in modern terminals including iTerm2, kitty, Alacritty, WezTerm,
 * Windows Terminal, and ghostty. Also works over SSH.
 */
export function copyToClipboard(text: string): void {
	const encoded = Buffer.from(text).toString('base64');
	process.stdout.write(`\x1B]52;c;${encoded}\x07`);
}
