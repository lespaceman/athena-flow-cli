import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLAUDE_BINARY_ENV_VARS = [
	'ATHENA_CLAUDE_PATH',
	'CLAUDE_BINARY',
	'CLAUDE_PATH',
] as const;

export type ResolveClaudeBinaryOptions = {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	pathValue?: string;
	homeDir?: string;
	isExecutable?: (candidatePath: string) => boolean;
};

function isExecutablePath(candidatePath: string): boolean {
	try {
		fs.accessSync(candidatePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function macosFallbacks(homeDir: string): string[] {
	return [
		path.join(homeDir, '.local', 'bin', 'claude'),
		'/opt/homebrew/bin/claude',
		'/usr/local/bin/claude',
		'/usr/bin/claude',
	];
}

function linuxFallbacks(homeDir: string): string[] {
	return [
		path.join(homeDir, '.local', 'bin', 'claude'),
		'/usr/local/bin/claude',
		'/usr/bin/claude',
	];
}

function collectCandidatePaths(
	pathValue: string | undefined,
	platform: NodeJS.Platform,
	homeDir: string,
): string[] {
	const candidates: string[] = [];

	for (const entry of (pathValue ?? '').split(path.delimiter)) {
		if (!entry) continue;
		candidates.push(path.join(entry, 'claude'));
	}

	if (platform === 'darwin') {
		candidates.push(...macosFallbacks(homeDir));
	} else if (platform !== 'win32') {
		candidates.push(...linuxFallbacks(homeDir));
	}

	return [...new Set(candidates)];
}

export function resolveClaudeBinary(
	options: ResolveClaudeBinaryOptions = {},
): string | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const pathValue = options.pathValue ?? env['PATH'];
	const isExecutable = options.isExecutable ?? isExecutablePath;

	for (const envVar of CLAUDE_BINARY_ENV_VARS) {
		const configuredPath = env[envVar];
		if (!configuredPath) continue;
		return isExecutable(configuredPath) ? configuredPath : null;
	}

	for (const candidatePath of collectCandidatePaths(
		pathValue,
		platform,
		homeDir,
	)) {
		if (isExecutable(candidatePath)) {
			return candidatePath;
		}
	}

	return null;
}
