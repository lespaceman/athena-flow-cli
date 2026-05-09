import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {runExec} from '../exec';
import type {ExecRunOptions, ExecRunResult} from '../exec/types';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
	InstanceSocketLogger,
} from './instanceSocketClient';

type JobAssignmentFrame = Extract<
	InstanceSocketFrame,
	{type: 'job_assignment'}
>;

type RemoteRunSpec = {
	prompt: string;
	sessionId?: string;
	projectDir?: string;
	workflow?: {ref?: string};
	env?: Record<string, string>;
	timeoutSec?: number;
};

export type ExecuteRemoteAssignmentInput = {
	frame: JobAssignmentFrame;
	client: Pick<InstanceSocketClient, 'sendRunEvent'>;
	projectDir?: string;
	log?: InstanceSocketLogger;
	runExecFn?: (options: ExecRunOptions) => Promise<ExecRunResult>;
	bootstrapRuntimeConfigFn?: typeof bootstrapRuntimeConfig;
	now?: () => number;
	abortSignal?: AbortSignal;
};

type JsonExecEvent = {
	type?: unknown;
	ts?: unknown;
	data?: unknown;
};

function parseRunSpec(value: unknown): RemoteRunSpec | null {
	if (typeof value !== 'object' || value === null) return null;
	const obj = value as Record<string, unknown>;
	const prompt = obj['prompt'];
	if (typeof prompt !== 'string' || prompt.trim().length === 0) return null;
	const env = obj['env'];
	const workflow = obj['workflow'];
	return {
		prompt,
		sessionId:
			typeof obj['sessionId'] === 'string' && obj['sessionId'].length > 0
				? obj['sessionId']
				: undefined,
		projectDir:
			typeof obj['projectDir'] === 'string' && obj['projectDir'].length > 0
				? obj['projectDir']
				: undefined,
		workflow:
			typeof workflow === 'object' &&
			workflow !== null &&
			typeof (workflow as Record<string, unknown>)['ref'] === 'string'
				? {ref: (workflow as Record<string, string>)['ref']}
				: undefined,
		env:
			typeof env === 'object' && env !== null
				? Object.fromEntries(
						Object.entries(env as Record<string, unknown>).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === 'string',
						),
					)
				: undefined,
		timeoutSec:
			typeof obj['timeoutSec'] === 'number' &&
			Number.isFinite(obj['timeoutSec'])
				? obj['timeoutSec']
				: undefined,
	};
}

function workflowNameFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const [name] = ref.split('@', 1);
	return name && name.length > 0 ? name : undefined;
}

function eventKind(event: JsonExecEvent): string {
	if (event.type === 'exec.completed') {
		const data = event.data as {success?: unknown} | null;
		return data?.success === false ? 'error' : 'completion';
	}
	return typeof event.type === 'string' && event.type.length > 0
		? event.type
		: 'progress';
}

function eventPayload(event: JsonExecEvent): unknown {
	if (event.type === 'exec.completed') {
		const data = event.data as {success?: unknown; failure?: unknown} | null;
		if (data?.success === false) {
			return {
				...(typeof event.data === 'object' && event.data !== null
					? event.data
					: {}),
				message:
					typeof data.failure === 'object' &&
					data.failure !== null &&
					typeof (data.failure as {message?: unknown}).message === 'string'
						? (data.failure as {message: string}).message
						: 'remote execution failed',
			};
		}
	}
	return event.data ?? null;
}

function withEnv<T>(
	env: Record<string, string> | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	if (!env || Object.keys(env).length === 0) return fn();
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	return fn().finally(() => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});
}

export async function executeRemoteAssignment({
	frame,
	client,
	projectDir: fallbackProjectDir = process.cwd(),
	log = () => {},
	runExecFn = runExec,
	bootstrapRuntimeConfigFn = bootstrapRuntimeConfig,
	now = Date.now,
	abortSignal,
}: ExecuteRemoteAssignmentInput): Promise<void> {
	let seq = 0;
	let lastTerminalFailureMessage: string | null = null;
	let deferredFailedCompletion: JsonExecEvent | null = null;
	const send = (kind: string, payload: unknown, ts = now()): void => {
		seq += 1;
		if (
			kind === 'error' &&
			typeof payload === 'object' &&
			payload !== null &&
			typeof (payload as {message?: unknown}).message === 'string'
		) {
			lastTerminalFailureMessage = (payload as {message: string}).message;
		}
		client.sendRunEvent({
			runId: frame.runId,
			seq,
			ts,
			kind,
			payload,
		});
	};

	send('progress', {message: 'assignment received'});

	const spec = parseRunSpec(frame.runSpec);
	if (!spec) {
		send('error', {
			message: 'remote assignment missing prompt',
		});
		return;
	}

	const projectDir = spec.projectDir ?? fallbackProjectDir;
	let runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>;
	try {
		runtimeConfig = bootstrapRuntimeConfigFn({
			projectDir,
			showSetup: false,
			isolationPreset: 'minimal',
			workflowOverride: workflowNameFromRef(spec.workflow?.ref),
		});
	} catch (err) {
		send('error', {
			message: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	for (const warning of runtimeConfig.warnings) {
		send('warning', {message: warning});
	}

	let buffered = '';
	const stdout = {
		write(chunk: string): boolean {
			buffered += chunk;
			let newline = buffered.indexOf('\n');
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line.length > 0) {
					try {
						const event = JSON.parse(line) as JsonExecEvent;
						const data = event.data as {success?: unknown} | null;
						if (event.type === 'exec.completed' && data?.success === false) {
							deferredFailedCompletion = event;
							continue;
						}
						send(eventKind(event), eventPayload(event), now());
					} catch (err) {
						send('progress', {line});
						log(
							'warn',
							`remote run emitted malformed JSONL: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
				newline = buffered.indexOf('\n');
			}
			return true;
		},
	};
	const stderr = {
		write(chunk: string): boolean {
			const text = chunk.trim();
			if (text.length > 0) send('stderr', {text});
			return true;
		},
	};

	try {
		await withEnv(spec.env, async () => {
			const result = await runExecFn({
				prompt: spec.prompt,
				projectDir,
				harness: runtimeConfig.harness,
				athenaSessionId: spec.sessionId ?? `athena-${frame.runId}`,
				isolationConfig: runtimeConfig.isolationConfig,
				pluginMcpConfig: runtimeConfig.pluginMcpConfig,
				workflow: runtimeConfig.workflow,
				workflowPlan: runtimeConfig.workflowPlan,
				json: true,
				verbose: false,
				ephemeral: false,
				timeoutMs: spec.timeoutSec ? spec.timeoutSec * 1000 : undefined,
				signal: abortSignal,
				onPermission: 'fail',
				onQuestion: 'fail',
				stdout,
				stderr,
			});
			if (deferredFailedCompletion) {
				const data =
					typeof deferredFailedCompletion.data === 'object' &&
					deferredFailedCompletion.data !== null
						? deferredFailedCompletion.data
						: {};
				send(
					'error',
					{
						...data,
						success: result.success,
						exitCode: result.exitCode,
						athenaSessionId: result.athenaSessionId,
						adapterSessionId: result.adapterSessionId,
						finalMessage: result.finalMessage,
						tokens: result.tokens,
						durationMs: result.durationMs,
						message:
							result.failure?.message ??
							(eventPayload(deferredFailedCompletion) as {message?: string})
								.message ??
							'remote execution failed',
					},
					typeof deferredFailedCompletion.ts === 'number'
						? deferredFailedCompletion.ts
						: now(),
				);
				return;
			}
			if (
				result.failure &&
				result.failure.message !== lastTerminalFailureMessage
			) {
				send('error', {
					success: result.success,
					exitCode: result.exitCode,
					athenaSessionId: result.athenaSessionId,
					adapterSessionId: result.adapterSessionId,
					finalMessage: result.finalMessage,
					tokens: result.tokens,
					durationMs: result.durationMs,
					message: result.failure.message,
				});
			}
		});
	} catch (err) {
		send('error', {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
