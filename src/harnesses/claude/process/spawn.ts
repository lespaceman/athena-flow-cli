import {spawn, type ChildProcess} from 'node:child_process';
import {processRegistry} from '../../../shared/utils/processRegistry';
import {type SpawnClaudeOptions} from './types';
import {resolveIsolationConfig} from '../config/isolation';
import {
	generateHookSettings,
	registerCleanupOnExit,
} from '../hooks/generateHookSettings';
import {buildIsolationArgs, validateConflicts} from '../config/flagRegistry';

/**
 * Spawns a Claude Code headless process with the given prompt.
 *
 * Uses `claude -p` for proper headless/programmatic mode with streaming JSON output.
 * Passes ATHENA_INSTANCE_ID env var so hook-forwarder can route to the correct socket.
 *
 * By default, uses strict isolation:
 * - Only loads user settings (API keys, model preferences)
 * - Skips project/local settings
 * - Injects athena's hooks via temp settings file
 * - Blocks project MCP servers
 */
export function spawnClaude(options: SpawnClaudeOptions): ChildProcess {
	const {
		prompt,
		projectDir,
		instanceId,
		sessionId,
		isolation,
		env: extraEnv,
		onStdout,
		onStderr,
		onExit,
		onError,
		jqFilter,
		onFilteredStdout,
		onJqStderr,
	} = options;

	// Resolve isolation config (defaults to strict)
	const isolationConfig = resolveIsolationConfig(isolation);

	// Generate temp settings file with athena's hooks
	const {settingsPath, cleanup} = generateHookSettings();
	registerCleanupOnExit(cleanup);

	// Build CLI arguments
	const args = ['-p', prompt, '--output-format', 'stream-json'];

	// Add isolation flags
	args.push('--settings', settingsPath);

	// Full settings isolation: don't load any Claude settings
	// All configuration comes from athena's generated settings file
	// Authentication still works (stored in ~/.claude.json, not settings)
	args.push('--setting-sources', '');

	// Validate and warn about conflicting flags (non-fatal: conflicts are
	// logged to stderr but both flags are still passed to Claude's CLI parser)
	const conflicts = validateConflicts(isolationConfig);
	for (const warning of conflicts) {
		console.error(`[athena] ${warning}`);
	}

	// Build isolation flags from declarative registry
	args.push(...buildIsolationArgs(isolationConfig));

	// Session management: sessionId takes precedence over continueSession
	// (handled outside registry since sessionId is from SpawnClaudeOptions, not IsolationConfig)
	if (sessionId) {
		args.push('--resume', sessionId);
	} else if (isolationConfig.continueSession) {
		args.push('--continue');
	}

	// Debug logging
	if (process.env['ATHENA_DEBUG']) {
		console.error('[athena-debug] Spawning claude with args:', args);
	}

	const child = spawn('claude', args, {
		cwd: projectDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...(extraEnv ?? {}),
			...process.env,
			ATHENA_INSTANCE_ID: String(instanceId),
		},
	});

	// Register for cleanup on app exit
	processRegistry.register(child);

	if (onStdout) {
		child.stdout.on('data', (data: Buffer) => {
			onStdout(data.toString());
		});
	}

	if (onStderr) {
		child.stderr.on('data', (data: Buffer) => {
			onStderr(data.toString());
		});
	}

	// Spawn jq sidecar to filter stdout when jqFilter is set
	if (jqFilter) {
		const jqChild = spawn('jq', ['--unbuffered', '-rj', jqFilter], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		processRegistry.register(jqChild);

		// Forward Claude's stdout to jq's stdin (manual write to avoid pipe() conflict)
		child.stdout.on('data', (data: Buffer) => {
			try {
				jqChild.stdin.write(data);
			} catch {
				// jq may have exited; suppress write errors
			}
		});
		child.stdout.on('end', () => {
			try {
				jqChild.stdin.end();
			} catch {
				// Suppress errors if jq stdin is already closed
			}
		});

		// Wire jq stdout to filtered callback
		if (onFilteredStdout) {
			jqChild.stdout.on('data', (data: Buffer) => {
				onFilteredStdout(data.toString());
			});
		}

		// Wire jq stderr to error callback
		if (onJqStderr) {
			jqChild.stderr.on('data', (data: Buffer) => {
				onJqStderr(data.toString());
			});
		}

		// Suppress EPIPE errors on jq stdin
		jqChild.stdin.on('error', () => {
			// jq may exit before Claude finishes writing
		});

		// Handle jq spawn failure
		jqChild.on('error', (error: Error) => {
			if (onJqStderr) {
				onJqStderr(`[jq error] ${error.message}`);
			}
		});
	}

	// Clean up temp settings file when process exits
	child.on('exit', (code: number | null) => {
		cleanup();
		if (onExit) {
			onExit(code);
		}
	});

	// Always attach error handler to prevent unhandled error events
	// Node.js EventEmitter throws if 'error' event has no listener
	child.on('error', (error: Error) => {
		cleanup();
		if (onError) {
			onError(error);
		}
		// If no handler provided, error is silently ignored
		// (process will exit via 'exit' event)
	});

	return child;
}
