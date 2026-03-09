import {execFileSync} from 'node:child_process';
import {resolveClaudeBinary} from './resolveBinary';

/**
 * Detect the installed Claude Code version by running `claude --version`.
 * Returns the semver string (e.g. "2.1.38") or null on any failure.
 */
export function detectClaudeVersion(): string | null {
	try {
		const claudeBinary = resolveClaudeBinary();
		if (!claudeBinary) return null;

		const output = execFileSync(claudeBinary, ['--version'], {
			timeout: 5000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const match = output.trim().match(/^([\d.]+)/);
		return match ? match[1]! : null;
	} catch {
		return null;
	}
}
