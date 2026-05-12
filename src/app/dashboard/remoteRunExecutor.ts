import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {runExec} from '../exec';
import type {ExecRunOptions, ExecRunResult} from '../exec/types';
import {installWorkflowFromSource, resolveWorkflow} from '../../core/workflows';
import {readGlobalConfig} from '../../infra/plugins/config';
import {
	resolveWorkflowInstall,
	type ResolvedWorkflowSource,
} from '../../infra/plugins/marketplace';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
	InstanceSocketLogger,
} from './instanceSocketClient';
import {
	createRunStreamClient,
	type RunStreamClient,
	type RunStreamClientOptions,
} from './runStreamClient';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

type JobAssignmentFrame = Extract<
	InstanceSocketFrame,
	{type: 'job_assignment'}
>;

type RemoteRunSpec = {
	prompt: string;
	athenaSessionId?: string;
	adapterResumeSessionId?: string;
	sessionId?: string;
	projectDir?: string;
	workflow?: {source?: string; ref?: string; version?: string};
	env?: Record<string, string>;
	timeoutSec?: number;
	/**
	 * Per-run callback channel minted by the dashboard's `prepareDispatch`.
	 * When both fields are present, the executor opens a dedicated WebSocket
	 * to RunStreamDO instead of relaying frames through the long-lived
	 * instance socket. The per-run channel survives instance-socket
	 * disconnects and replays unacked frames on reconnect — see
	 * `runStreamClient.ts` for the full protocol.
	 */
	callbackWsUrl?: string;
	callbackToken?: string;
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
	/** Test seam — override the per-run stream client factory. */
	createRunStreamClientFn?: (opts: RunStreamClientOptions) => RunStreamClient;
	resolveWorkflowFn?: typeof resolveWorkflow;
	resolveWorkflowInstallFn?: typeof resolveWorkflowInstall;
	installWorkflowFromSourceFn?: typeof installWorkflowFromSource;
	readGlobalConfigFn?: typeof readGlobalConfig;
	/**
	 * Bound on how long to wait for the per-run WebSocket to come up before
	 * falling back to the instance-socket relay. Default 5s — short enough
	 * that a transient outage doesn't stall the user-visible
	 * "assignment received" frame.
	 */
	runStreamConnectTimeoutMs?: number;
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
	const callbackWsUrl = obj['callbackWsUrl'];
	const callbackToken = obj['callbackToken'];
	const workflowObj =
		typeof workflow === 'object' && workflow !== null
			? (workflow as Record<string, unknown>)
			: null;
	return {
		prompt,
		athenaSessionId:
			typeof obj['athenaSessionId'] === 'string' &&
			obj['athenaSessionId'].length > 0
				? obj['athenaSessionId']
				: undefined,
		adapterResumeSessionId:
			typeof obj['adapterResumeSessionId'] === 'string' &&
			obj['adapterResumeSessionId'].length > 0
				? obj['adapterResumeSessionId']
				: undefined,
		sessionId:
			typeof obj['sessionId'] === 'string' && obj['sessionId'].length > 0
				? obj['sessionId']
				: undefined,
		projectDir:
			typeof obj['projectDir'] === 'string' && obj['projectDir'].length > 0
				? obj['projectDir']
				: undefined,
		workflow:
			workflowObj && typeof workflowObj['ref'] === 'string'
				? {
						ref: workflowObj['ref'],
						...(typeof workflowObj['source'] === 'string'
							? {source: workflowObj['source']}
							: {}),
						...(typeof workflowObj['version'] === 'string'
							? {version: workflowObj['version']}
							: {}),
					}
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
		callbackWsUrl:
			typeof callbackWsUrl === 'string' && callbackWsUrl.length > 0
				? callbackWsUrl
				: undefined,
		callbackToken:
			typeof callbackToken === 'string' && callbackToken.length > 0
				? callbackToken
				: undefined,
	};
}

function workflowNameFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const [name] = ref.split('@', 1);
	return name && name.length > 0 ? name : undefined;
}

function isMissingWorkflowError(err: unknown, workflowName: string): boolean {
	return (
		err instanceof Error &&
		err.message.includes(`Workflow "${workflowName}" not found`)
	);
}

function configuredWorkflowSources(
	readGlobalConfigFn: typeof readGlobalConfig,
): string[] {
	const sources = readGlobalConfigFn().workflowMarketplaceSources;
	return sources && sources.length > 0 ? sources : [DEFAULT_MARKETPLACE_SLUG];
}

function workflowInstallRef(spec: RemoteRunSpec): string | undefined {
	const ref = spec.workflow?.ref;
	if (!ref) return undefined;
	const version = spec.workflow?.version;
	if (version && !ref.includes('@')) {
		return `${ref}@${version}`;
	}
	return ref;
}

function workflowInstallSources(
	spec: RemoteRunSpec,
	readGlobalConfigFn: typeof readGlobalConfig,
): string[] {
	const source = spec.workflow?.source?.trim();
	if (source && source !== 'marketplace') {
		return [source];
	}
	return configuredWorkflowSources(readGlobalConfigFn);
}

function ensureRemoteWorkflowInstalled(input: {
	spec: RemoteRunSpec;
	resolveWorkflowFn: typeof resolveWorkflow;
	resolveWorkflowInstallFn: typeof resolveWorkflowInstall;
	installWorkflowFromSourceFn: typeof installWorkflowFromSource;
	readGlobalConfigFn: typeof readGlobalConfig;
}): string | undefined {
	const ref = workflowInstallRef(input.spec);
	const workflowName = workflowNameFromRef(ref);
	if (!workflowName) return undefined;

	try {
		input.resolveWorkflowFn(workflowName);
		return workflowName;
	} catch (err) {
		if (!isMissingWorkflowError(err, workflowName)) {
			throw err;
		}
	}

	const resolved: ResolvedWorkflowSource = input.resolveWorkflowInstallFn(
		ref!,
		workflowInstallSources(input.spec, input.readGlobalConfigFn),
	);
	return input.installWorkflowFromSourceFn(resolved);
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
	createRunStreamClientFn = createRunStreamClient,
	resolveWorkflowFn = resolveWorkflow,
	resolveWorkflowInstallFn = resolveWorkflowInstall,
	installWorkflowFromSourceFn = installWorkflowFromSource,
	readGlobalConfigFn = readGlobalConfig,
	runStreamConnectTimeoutMs = 5_000,
}: ExecuteRemoteAssignmentInput): Promise<void> {
	let lastTerminalFailureMessage: string | null = null;
	let deferredFailedCompletion: JsonExecEvent | null = null;

	// Pre-parse so we know whether to open the per-run channel before the
	// first frame. parseRunSpec is cheap and side-effect-free.
	const spec = parseRunSpec(frame.runSpec);

	// Open the per-run RunStreamDO channel when the dashboard supplied
	// callback credentials. This is the durable path: it queues frames during
	// disconnects and uses the server's resume protocol to replay them. Falls
	// back to the legacy instance-socket relay when the credentials aren't
	// present (older dashboard) or connect fails within the timeout.
	let runStream: RunStreamClient | null = null;
	if (spec?.callbackWsUrl && spec.callbackToken) {
		const connect = createRunStreamClientFn({
			wsUrl: spec.callbackWsUrl,
			token: spec.callbackToken,
			log: (level, message) =>
				log(level, `run-stream[${frame.runId}]: ${message}`),
			now,
		});
		const timeoutPromise = new Promise<'timeout'>(resolve => {
			const t = setTimeout(() => resolve('timeout'), runStreamConnectTimeoutMs);
			t.unref();
		});
		try {
			const result = await Promise.race([
				connect.connect().then(() => 'connected' as const),
				timeoutPromise,
			]);
			if (result === 'connected') {
				runStream = connect;
			} else {
				log(
					'warn',
					`run-stream[${frame.runId}]: connect timed out after ${runStreamConnectTimeoutMs}ms; falling back to instance-socket relay`,
				);
				void connect.close('connect_timeout');
			}
		} catch (err) {
			log(
				'warn',
				`run-stream[${frame.runId}]: connect failed (${
					err instanceof Error ? err.message : String(err)
				}); falling back to instance-socket relay`,
			);
		}
	}

	// Single send seam: routes through the per-run client when up, otherwise
	// falls back to the instance-socket relay (with its known reliability
	// limitations). Legacy seq is owned by the closure; the per-run client
	// owns its own seq counter internally.
	let legacySeq = 0;
	const send = (kind: string, payload: unknown, ts = now()): void => {
		if (
			kind === 'error' &&
			typeof payload === 'object' &&
			payload !== null &&
			typeof (payload as {message?: unknown}).message === 'string'
		) {
			lastTerminalFailureMessage = (payload as {message: string}).message;
		}
		if (runStream) {
			runStream.sendEvent({ts, kind, payload});
			return;
		}
		legacySeq += 1;
		client.sendRunEvent({
			runId: frame.runId,
			seq: legacySeq,
			ts,
			kind,
			payload,
		});
	};

	send('progress', {message: 'assignment received'});

	try {
		if (!spec) {
			send('error', {message: 'remote assignment missing prompt'});
			return;
		}

		const projectDir = spec.projectDir ?? fallbackProjectDir;
		let runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>;
		try {
			const workflowOverride = ensureRemoteWorkflowInstalled({
				spec,
				resolveWorkflowFn,
				resolveWorkflowInstallFn,
				installWorkflowFromSourceFn,
				readGlobalConfigFn,
			});
			runtimeConfig = bootstrapRuntimeConfigFn({
				projectDir,
				showSetup: false,
				isolationPreset: 'minimal',
				workflowOverride,
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
					athenaSessionId:
						spec.athenaSessionId ?? spec.sessionId ?? `athena-${frame.runId}`,
					adapterResumeSessionId: spec.adapterResumeSessionId,
					isolationConfig: runtimeConfig.isolationConfig,
					pluginMcpConfig: runtimeConfig.pluginMcpConfig,
					workflow: runtimeConfig.workflow,
					workflowPlan: runtimeConfig.workflowPlan,
					dashboardOrigin: 'dashboard',
					json: true,
					verbose: false,
					ephemeral: false,
					timeoutMs: spec.timeoutSec ? spec.timeoutSec * 1000 : undefined,
					signal: abortSignal,
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
	} finally {
		// Wait briefly for the server to ack the terminal frame (so `finalize`
		// fires on the dashboard) but cap at 10s — if the server is
		// unreachable we still need to release the daemon's reference.
		if (runStream) {
			const drainTimeout = new Promise<void>(resolve => {
				const t = setTimeout(() => resolve(), 10_000);
				t.unref();
			});
			await Promise.race([runStream.whenTerminated(), drainTimeout]);
			await runStream.close('done');
		}
	}
}
