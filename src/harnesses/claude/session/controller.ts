import type {ChildProcess} from 'node:child_process';
import {spawnClaude} from '../process/spawn';
import {
	type IsolationConfig,
	type IsolationPreset,
	resolveIsolationConfig,
} from '../config/isolation';
import {createTokenAccumulator} from '../process/tokenAccumulator';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';

type StreamMessageRecord = Record<string, unknown>;

const NULL_TOKENS = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
} as const;

function asRecord(value: unknown): StreamMessageRecord | null {
	if (typeof value === 'object' && value !== null) {
		return value as StreamMessageRecord;
	}
	return null;
}

function readAssistantText(message: StreamMessageRecord): string | null {
	if (message['role'] !== 'assistant') return null;
	const content = message['content'];
	if (!Array.isArray(content)) return null;

	const parts: string[] = [];
	for (const block of content) {
		const rec = asRecord(block);
		if (!rec || rec['type'] !== 'text') continue;
		if (typeof rec['text'] === 'string' && rec['text'].length > 0) {
			parts.push(rec['text']);
		}
	}

	return parts.length > 0 ? parts.join('') : null;
}

function createAssistantMessageAccumulator() {
	let buffer = '';
	let lastMessage: string | null = null;

	function processLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.trim());
		} catch {
			return;
		}

		const record = asRecord(parsed);
		if (!record || record['parent_tool_use_id'] != null) {
			return;
		}

		let nextMessage: string | null = null;
		if (record['type'] === 'assistant') {
			nextMessage = readAssistantText(asRecord(record['message']) ?? {});
		} else if (record['type'] === 'message') {
			nextMessage = readAssistantText(record);
		}

		if (nextMessage && nextMessage.trim().length > 0) {
			lastMessage = nextMessage;
		}
	}

	return {
		feed(chunk: string): void {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				processLine(line);
			}
		},
		flush(): void {
			if (!buffer.trim()) return;
			processLine(buffer);
			buffer = '';
		},
		getLastMessage(): string | null {
			return lastMessage;
		},
	};
}

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

	return {
		startTurn({
			prompt,
			sessionId,
			configOverride,
			onStderrLine,
		}): Promise<SessionControllerTurnResult> {
			const tokenAccumulator = createTokenAccumulator();
			const messageAccumulator = createAssistantMessageAccumulator();

			return new Promise(resolve => {
				let settled = false;
				const finalize = (exitCode: number | null, error: Error | null) => {
					if (settled) return;
					settled = true;
					tokenAccumulator.flush();
					messageAccumulator.flush();
					activeChild = null;
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
						sessionId,
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
		},

		interrupt(): void {
			activeChild?.kill('SIGINT');
		},

		async kill(): Promise<void> {
			if (!activeChild) return;
			try {
				activeChild.kill();
			} catch {
				// Best effort.
			} finally {
				activeChild = null;
			}
		},
	};
}
