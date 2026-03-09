import {execFileSync} from 'node:child_process';
import type {
	HarnessVerificationCheck,
	HarnessVerificationResult,
} from '../../types';

const MIN_VERSION = '0.37.0';

function resolveCodexBinary(): string | null {
	try {
		const result = execFileSync('which', ['codex'], {
			timeout: 5000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		return result || null;
	} catch {
		return null;
	}
}

function detectCodexVersion(): string | null {
	try {
		const raw = execFileSync('codex', ['--version'], {
			timeout: 5000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		const match = raw.match(/(\d+\.\d+\.\d+)/);
		return match ? match[1]! : null;
	} catch {
		return null;
	}
}

export function isVersionSufficient(
	version: string,
	minVersion: string,
): boolean {
	const parse = (v: string) => v.split('.').map(Number);
	const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(version);
	const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(minVersion);
	if (aMajor !== bMajor) return aMajor > bMajor;
	if (aMinor !== bMinor) return aMinor > bMinor;
	return aPatch >= bPatch;
}

export function verifyCodexHarness(): HarnessVerificationResult {
	const checks: HarnessVerificationCheck[] = [];
	const binary = resolveCodexBinary();
	const version = binary ? detectCodexVersion() : null;

	if (binary) {
		checks.push({label: 'Codex binary', status: 'pass', message: binary});
	} else {
		checks.push({
			label: 'Codex binary',
			status: 'fail',
			message:
				'Not found in PATH. Install OpenAI Codex CLI: npm i -g @openai/codex',
		});
	}

	if (version) {
		const sufficient = isVersionSufficient(version, MIN_VERSION);
		checks.push({
			label: 'Codex version',
			status: sufficient ? 'pass' : 'fail',
			message: sufficient
				? `v${version}`
				: `v${version} is below minimum v${MIN_VERSION}. Run: npm update -g @openai/codex`,
		});
	} else {
		checks.push({
			label: 'Codex version',
			status: 'fail',
			message: 'Unable to read `codex --version`.',
		});
	}

	const hasFailure = checks.some(c => c.status === 'fail');
	return {
		ok: !hasFailure,
		summary: hasFailure
			? 'OpenAI Codex setup needs attention'
			: `OpenAI Codex v${version} detected`,
		checks,
	};
}
