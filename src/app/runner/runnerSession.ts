/**
 * Stateful router for runner envelopes inside a harness child.
 *
 * Owns the AbortController for each in-flight assignment so that a `cancel`
 * envelope can interrupt the matching `job_assignment` without the AppShell
 * needing to track per-run state. Returns a `recognised` flag so the dispatch
 * handler can fall through to the chat path when the text is not a runner
 * envelope.
 */
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {runExec} from '../exec';
import type {ExecRunOptions, ExecRunResult} from '../exec/types';
import type {ChannelLocation} from '../../shared/gateway-protocol';
import {executeAssignment, type AssignmentBridge} from './assignmentHandler';
import {parseRunnerEnvelope} from './envelope';

export type RunnerSessionOptions = {
	bridge: AssignmentBridge;
	projectDir?: string;
	runExecFn?: (options: ExecRunOptions) => Promise<ExecRunResult>;
	bootstrapRuntimeConfigFn?: typeof bootstrapRuntimeConfig;
	now?: () => number;
};

export type RunnerDispatchInput = {
	text: string;
	dispatchId: string;
	location: ChannelLocation;
};

export type RunnerDispatchResult = {
	/** True if the text parsed as a runner envelope and was handled here. */
	recognised: boolean;
	/** Resolves once the dispatch has fully drained (assignment completed or cancel ack). */
	completed: Promise<void>;
};

export type RunnerSession = {
	handleDispatch(input: RunnerDispatchInput): RunnerDispatchResult;
};

export function createRunnerSession(opts: RunnerSessionOptions): RunnerSession {
	const {
		bridge,
		projectDir,
		runExecFn = runExec,
		bootstrapRuntimeConfigFn = bootstrapRuntimeConfig,
		now = Date.now,
	} = opts;
	const inflight = new Map<string, AbortController>();

	function startAssignment(
		envelope: ReturnType<typeof parseRunnerEnvelope> & {
			kind: 'job_assignment';
		},
		dispatchId: string,
		location: ChannelLocation,
	): Promise<void> {
		const controller = new AbortController();
		inflight.set(envelope.runId, controller);
		return executeAssignment({
			envelope,
			bridge,
			dispatchId,
			location,
			projectDir,
			runExecFn,
			bootstrapRuntimeConfigFn,
			now,
			abortSignal: controller.signal,
		}).finally(() => {
			if (inflight.get(envelope.runId) === controller) {
				inflight.delete(envelope.runId);
			}
		});
	}

	return {
		handleDispatch(input: RunnerDispatchInput): RunnerDispatchResult {
			const envelope = parseRunnerEnvelope(input.text);
			if (!envelope) {
				return {recognised: false, completed: Promise.resolve()};
			}
			if (envelope.kind === 'job_assignment') {
				const completed = startAssignment(
					envelope as Extract<typeof envelope, {kind: 'job_assignment'}>,
					input.dispatchId,
					input.location,
				);
				return {recognised: true, completed};
			}
			// cancel
			const controller = inflight.get(envelope.runId);
			if (controller) controller.abort();
			return {recognised: true, completed: Promise.resolve()};
		},
	};
}
