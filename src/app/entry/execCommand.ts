import crypto from 'node:crypto';
import {
	getMostRecentAthenaSession,
	getSessionMeta,
} from '../../infra/sessions/index';
import type {RuntimeBootstrapOutput} from '../bootstrap/bootstrapConfig';
import {runExec, EXEC_EXIT_CODE} from '../exec';

export type ExecCliFlags = {
	continueFlag?: string;
	json: boolean;
	outputLastMessage?: string;
	ephemeral: boolean;
	timeoutMs?: number;
	verbose: boolean;
	channels?: readonly string[];
};

export type ExecRuntimeConfig = Pick<
	RuntimeBootstrapOutput,
	| 'harness'
	| 'isolationConfig'
	| 'pluginMcpConfig'
	| 'workflow'
	| 'workflowPlan'
>;

export type RunExecCommandInput = {
	projectDir: string;
	prompt: string;
	flags: ExecCliFlags;
	runtimeConfig: ExecRuntimeConfig;
};

export type RunExecCommandDeps = {
	logError?: (message: string) => void;
	createSessionId?: () => string;
	runExecFn?: typeof runExec;
	getMostRecentSessionFn?: typeof getMostRecentAthenaSession;
	getSessionMetaFn?: typeof getSessionMeta;
};

function isValidTimeout(timeoutMs: number | undefined): boolean {
	if (timeoutMs === undefined) return true;
	return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

type ContinueResolution = {
	athenaSessionId: string;
	adapterResumeSessionId: string | undefined;
};

function resolveContinueFlag(input: {
	projectDir: string;
	continueFlag: string | undefined;
	createSessionId: () => string;
	getMostRecentSessionFn: typeof getMostRecentAthenaSession;
	getSessionMetaFn: typeof getSessionMeta;
	logError: (message: string) => void;
}): ContinueResolution | undefined {
	if (input.continueFlag === undefined) {
		return {
			athenaSessionId: input.createSessionId(),
			adapterResumeSessionId: undefined,
		};
	}

	if (input.continueFlag === '') {
		const recent = input.getMostRecentSessionFn(input.projectDir);
		if (!recent) {
			input.logError(
				'Error: --continue was provided but no previous Athena sessions exist for this project.',
			);
			return undefined;
		}
		return {
			athenaSessionId: recent.id,
			adapterResumeSessionId: recent.adapterSessionIds.at(-1),
		};
	}

	const meta = input.getSessionMetaFn(input.continueFlag);
	if (!meta) {
		input.logError(`Error: Unknown Athena session ID: ${input.continueFlag}`);
		return undefined;
	}
	return {
		athenaSessionId: meta.id,
		adapterResumeSessionId: meta.adapterSessionIds.at(-1),
	};
}

export async function runExecCommand(
	input: RunExecCommandInput,
	deps: RunExecCommandDeps = {},
): Promise<number> {
	const logError = deps.logError ?? console.error;
	const createSessionId = deps.createSessionId ?? crypto.randomUUID;
	const runExecFn = deps.runExecFn ?? runExec;
	const getMostRecentSessionFn =
		deps.getMostRecentSessionFn ?? getMostRecentAthenaSession;
	const getSessionMetaFn = deps.getSessionMetaFn ?? getSessionMeta;

	if (input.flags.ephemeral && input.flags.continueFlag !== undefined) {
		logError('Error: --ephemeral cannot be combined with --continue.');
		return EXEC_EXIT_CODE.USAGE;
	}

	if (!isValidTimeout(input.flags.timeoutMs)) {
		logError('Error: --timeout-ms must be a positive number.');
		return EXEC_EXIT_CODE.USAGE;
	}

	let continueResolution: ContinueResolution | undefined;
	try {
		continueResolution = resolveContinueFlag({
			projectDir: input.projectDir,
			continueFlag: input.flags.continueFlag,
			createSessionId,
			getMostRecentSessionFn,
			getSessionMetaFn,
			logError,
		});
	} catch (error) {
		logError(
			`Error: Failed to resolve --continue session: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return EXEC_EXIT_CODE.RUNTIME;
	}
	if (!continueResolution) {
		return EXEC_EXIT_CODE.RUNTIME;
	}

	const result = await runExecFn({
		prompt: input.prompt,
		projectDir: input.projectDir,
		harness: input.runtimeConfig.harness,
		athenaSessionId: continueResolution.athenaSessionId,
		adapterResumeSessionId: continueResolution.adapterResumeSessionId,
		isolationConfig: input.runtimeConfig.isolationConfig,
		pluginMcpConfig: input.runtimeConfig.pluginMcpConfig,
		workflow: input.runtimeConfig.workflow,
		workflowPlan: input.runtimeConfig.workflowPlan,
		verbose: input.flags.verbose,
		json: input.flags.json,
		outputLastMessagePath: input.flags.outputLastMessage,
		ephemeral: input.flags.ephemeral,
		timeoutMs: input.flags.timeoutMs,
		channels: input.flags.channels,
	});

	return result.exitCode;
}
