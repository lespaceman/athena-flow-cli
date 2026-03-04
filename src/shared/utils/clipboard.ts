import {execSync} from 'node:child_process';

/**
 * Copy text to system clipboard.
 *
 * Strategy: try platform CLI tools first (xclip, wl-copy, pbcopy),
 * fall back to OSC 52 terminal escape sequence when unavailable.
 */
export function copyToClipboard(text: string): void {
	const cmd = getClipboardCommand();
	if (cmd) {
		try {
			execSync(cmd, {input: text, stdio: ['pipe', 'ignore', 'ignore']});
			return;
		} catch {
			// CLI tool failed — fall through to OSC 52
		}
	}
	// Fallback: OSC 52 terminal escape sequence
	const encoded = Buffer.from(text).toString('base64');
	process.stdout.write(`\x1B]52;c;${encoded}\x07`);
}

function getClipboardCommand(): string | null {
	if (process.platform === 'darwin') {
		return 'pbcopy';
	}
	if (process.platform === 'linux') {
		const session = process.env['XDG_SESSION_TYPE'];
		if (session === 'wayland') return 'wl-copy';
		return 'xclip -selection clipboard';
	}
	return null;
}
