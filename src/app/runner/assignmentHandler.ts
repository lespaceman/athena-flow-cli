/**
 * Harness-child handler for runner job assignments.
 *
 * Receives a parsed `job_assignment` envelope (from
 * `parseRunnerEnvelope`) and produces the matching wire frames the dashboard
 * expects:
 *
 *   - per-event progress envelopes via `bridge.sendRunEvent` (mapped to the
 *     gateway's `session.run.event` op, which the supervisor's
 *     RunnerAdapter forwards to the dashboard's instance socket)
 *   - one terminal envelope via `bridge.completeTurn` so the gateway can
 *     close the originating dispatch entry; the text is a `run_event`
 *     envelope with `eventKind: 'completion' | 'error'`
 *
 * Test seams (`runExecFn`, `bootstrapRuntimeConfigFn`, `now`,
 * `createRunStreamClientFn`) mirror the legacy `executeRemoteAssignment` so
 * existing parity expectations carry over.
 */
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {normalizeHarnessOverride} from '../bootstrap/harnessOverride';
import {runExec} from '../exec';
import type {ExecRunOptions, ExecRunResult} from '../exec/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {ChannelLocation} from '../../shared/gateway-protocol';
import type {RunnerEnvelope} from './envelope';

export type AssignmentBridgeRunEvent = {
	location: ChannelLocation;
	runId: string;
	seq: number;
	ts: number;
	kind: string;
	payload?: unknown;
};

export type AssignmentBridge = {
	sendRunEvent(event: AssignmentBridgeRunEvent): Promise<unknown> | void;
	completeTurn(input: {
		dispatchId: string;
		location: ChannelLocation;
		text: string;
		idempotencyKey: string;
	}): Promise<unknown>;
};

export type ExecuteAssignmentInput = {
	envelope: Extract<RunnerEnvelope, {kind: 'job_assignment'}>;
	bridge: AssignmentBridge;
	dispatchId: string;
	location: ChannelLocation;
	projectDir?: string;
	runExecFn?: (options: ExecRunOptions) => Promise<ExecRunResult>;
	bootstrapRuntimeConfigFn?: typeof bootstrapRuntimeConfig;
	now?: () => number;
	abortSignal?: AbortSignal;
};

type RemoteRunSpec = {
	prompt: string;
	sessionId?: string;
	projectDir?: string;
	workflow?: {ref?: string};
	harness?: AthenaHarness;
	env?: Record<string, string>;
	timeoutSec?: number;
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
		harness: normalizeHarnessOverride(obj['harness']),
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

function eventKindOf(event: JsonExecEvent): string {
	if (event.type === 'exec.completed') {
		const data = event.data as {success?: unknown} | null;
		return data?.success === false ? 'error' : 'completion';
	}
	return typeof event.type === 'string' && event.type.length > 0
		? event.type
		: 'progress';
}

function eventPayloadOf(event: JsonExecEvent): unknown {
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

export async function executeAssignment(
	input: ExecuteAssignmentInput,
): Promise<void> {
	const {
		envelope,
		bridge,
		dispatchId,
		location,
		projectDir: fallbackProjectDir = process.cwd(),
		runExecFn = runExec,
		bootstrapRuntimeConfigFn = bootstrapRuntimeConfig,
		now = Date.now,
		abortSignal,
	} = input;

	const runId = envelope.runId;
	let seq = 0;
	let terminalSent = false;
	let deferredFailedCompletion: JsonExecEvent | null = null;
	let lastTerminalFailureMessage: string | null = null;

	const nextSeq = (): number => {
		seq += 1;
		return seq;
	};

	const sendProgress = async (
		kind: string,
		payload: unknown,
		ts = now(),
	): Promise<void> => {
		await bridge.sendRunEvent({
			location,
			runId,
			seq: nextSeq(),
			ts,
			kind,
			payload,
		});
	};

	const sendTerminal = async (
		eventKind: 'completion' | 'error',
		payload: unknown,
		ts = now(),
	): Promise<void> => {
		if (terminalSent) return;
		terminalSent = true;
		const envelopeText = JSON.stringify({
			kind: 'run_event',
			runId,
			seq: nextSeq(),
			ts,
			eventKind,
			payload,
		});
		await bridge.completeTurn({
			dispatchId,
			location,
			text: envelopeText,
			idempotencyKey: `run_event:${runId}:terminal`,
		});
	};

	await sendProgress('progress', {message: 'assignment received'});

	const spec = parseRunSpec(envelope.runSpec);
	if (!spec) {
		await sendTerminal('error', {message: 'remote assignment missing prompt'});
		return;
	}

	const projectDir = spec.projectDir ?? fallbackProjectDir;
	let runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>;
	try {
		runtimeConfig = bootstrapRuntimeConfigFn({
			projectDir,
			showSetup: false,
			isolationPreset: 'minimal',
			harnessOverride: spec.harness,
			workflowOverride: workflowNameFromRef(spec.workflow?.ref),
		});
	} catch (err) {
		await sendTerminal('error', {
			message: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	for (const warning of runtimeConfig.warnings) {
		await sendProgress('warning', {message: warning});
	}

	let buffered = '';
	const pendingProgress: Array<Promise<void>> = [];
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
						} else if (event.type === 'exec.completed') {
							// Successful completion is emitted as the terminal envelope
							// after runExec returns, so the failure-path runExec result
							// can override it if needed.
							deferredFailedCompletion = event;
						} else {
							pendingProgress.push(
								sendProgress(eventKindOf(event), eventPayloadOf(event), now()),
							);
						}
					} catch {
						pendingProgress.push(sendProgress('progress', {line}));
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
			if (text.length > 0) pendingProgress.push(sendProgress('stderr', {text}));
			return true;
		},
	};

	try {
		await withEnv(spec.env, async () => {
			const result = await runExecFn({
				prompt: spec.prompt,
				projectDir,
				harness: runtimeConfig.harness,
				athenaSessionId: spec.sessionId ?? `athena-${runId}`,
				isolationConfig: runtimeConfig.isolationConfig,
				pluginMcpConfig: runtimeConfig.pluginMcpConfig,
				workflow: runtimeConfig.workflow,
				workflowPlan: runtimeConfig.workflowPlan,
				json: true,
				verbose: false,
				ephemeral: false,
				timeoutMs: spec.timeoutSec ? spec.timeoutSec * 1000 : undefined,
				signal: abortSignal,
				stdout,
				stderr,
			});
			await Promise.all(pendingProgress);
			if (deferredFailedCompletion) {
				const data =
					typeof deferredFailedCompletion.data === 'object' &&
					deferredFailedCompletion.data !== null
						? deferredFailedCompletion.data
						: {};
				const ts =
					typeof deferredFailedCompletion.ts === 'number'
						? deferredFailedCompletion.ts
						: now();
				const success = (data as {success?: unknown}).success !== false;
				const eventKind: 'completion' | 'error' = success
					? 'completion'
					: 'error';
				const message = !success
					? (result.failure?.message ??
						(eventPayloadOf(deferredFailedCompletion) as {message?: string})
							.message ??
						'remote execution failed')
					: undefined;
				if (message) lastTerminalFailureMessage = message;
				await sendTerminal(
					eventKind,
					success
						? {
								...data,
								exitCode: result.exitCode,
								athenaSessionId: result.athenaSessionId,
								adapterSessionId: result.adapterSessionId,
								finalMessage: result.finalMessage,
								tokens: result.tokens,
								durationMs: result.durationMs,
								success: true,
							}
						: {
								...data,
								success: result.success,
								exitCode: result.exitCode,
								athenaSessionId: result.athenaSessionId,
								adapterSessionId: result.adapterSessionId,
								finalMessage: result.finalMessage,
								tokens: result.tokens,
								durationMs: result.durationMs,
								message,
							},
					ts,
				);
				return;
			}
			if (
				result.failure &&
				result.failure.message !== lastTerminalFailureMessage
			) {
				await sendTerminal('error', {
					success: result.success,
					exitCode: result.exitCode,
					athenaSessionId: result.athenaSessionId,
					adapterSessionId: result.adapterSessionId,
					finalMessage: result.finalMessage,
					tokens: result.tokens,
					durationMs: result.durationMs,
					message: result.failure.message,
				});
				return;
			}
			await sendTerminal('completion', {
				success: result.success,
				exitCode: result.exitCode,
				athenaSessionId: result.athenaSessionId,
				adapterSessionId: result.adapterSessionId,
				finalMessage: result.finalMessage,
				tokens: result.tokens,
				durationMs: result.durationMs,
			});
		});
	} catch (err) {
		await Promise.all(pendingProgress);
		await sendTerminal('error', {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
