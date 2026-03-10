import type {ChildProcess} from 'node:child_process';
import {spawnClaude} from '../process/spawn';
import {
	type IsolationConfig,
	type IsolationPreset,
	resolveIsolationConfig,
} from '../config/isolation';
import {createTokenAccumulator} from '../process/tokenAccumulator';
import {createAssistantMessageAccumulator} from './assistantMessageAccumulator';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';
import type {TurnContinuation} from '../../../core/runtime/process';

function mergeIsolation(
	base: IsolationConfig | IsolationPreset | undefined,
	pluginMcpConfig: string | undefined,
	overrides: Partial<IsolationConfig> | undefined,
): IsolationConfig | IsolationPreset | undefined {
	if (!pluginMcpConfig && !overrides) return base;

	return {
		...resolveIsolationConfig(base),
		...(overrides ?? {}),
		...(pluginMcpConfig ? {mcpConfig: pluginMcpConfig} : {}),
	};
}

function resolveClaudeSessionId(
	continuation: TurnContinuation | undefined,
): string | undefined {
	if (!continuation || continuation.mode === 'fresh') {
		return undefined;
	}

	if (continuation.mode === 'resume') {
		return continuation.handle;
	}

	throw new Error(
		'Claude session controller does not support reuse-current continuation',
	);
}

export function createClaudeSessionController(
	input: CreateSessionControllerInput,
): SessionController {
	const spawnProcess =
		(input.spawnProcess as typeof spawnClaude | undefined) ?? spawnClaude;
	const processConfig = input.processConfig as
		| IsolationConfig
		| IsolationPreset
		| undefined;
	let activeChild: ChildProcess | null = null;
	let activeTurnPromise: Promise<SessionControllerTurnResult> | null = null;

	return {
		startTurn({
			prompt,
			continuation,
			configOverride,
			onStderrLine,
		}): Promise<SessionControllerTurnResult> {
			const tokenAccumulator = createTokenAccumulator();
			const messageAccumulator = createAssistantMessageAccumulator();

			const turnPromise = new Promise<SessionControllerTurnResult>(resolve => {
				let settled = false;
				const finalize = (exitCode: number | null, error: Error | null) => {
					if (settled) return;
					settled = true;
					tokenAccumulator.flush();
					messageAccumulator.flush();
					activeChild = null;
					activeTurnPromise = null;
					resolve({
						exitCode,
						error,
						tokens: tokenAccumulator.getUsage(),
						streamMessage: messageAccumulator.getLastMessage(),
					});
				};

				try {
					activeChild = spawnProcess({
						prompt,
						projectDir: input.projectDir,
						instanceId: input.instanceId,
						sessionId: resolveClaudeSessionId(continuation),
						isolation: mergeIsolation(
							processConfig,
							input.pluginMcpConfig,
							configOverride as Partial<IsolationConfig> | undefined,
						),
						env: input.workflow?.env,
						onStdout: (data: string) => {
							tokenAccumulator.feed(data);
							messageAccumulator.feed(data);
						},
						onStderr: (data: string) => {
							if (!input.verbose) return;
							onStderrLine?.(data.trim());
						},
						onExit: code => finalize(code, null),
						onError: error => finalize(null, error),
					});
				} catch (error) {
					finalize(
						null,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			});
			activeTurnPromise = turnPromise;
			return turnPromise;
		},

		interrupt(): void {
			activeChild?.kill('SIGINT');
		},

		async kill(): Promise<void> {
			if (!activeChild) return;
			try {
				activeChild.kill();
				await activeTurnPromise?.catch(() => {});
			} catch {
				// Best effort.
			} finally {
				activeChild = null;
			}
		},
	};
}
