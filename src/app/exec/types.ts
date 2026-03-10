import type {ChildProcess} from 'node:child_process';
import type {Writable} from 'node:stream';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {SessionStore} from '../../infra/sessions/store';
import type {RuntimeFactory} from '../runtime/createRuntime';
import type {SpawnClaudeOptions} from '../../harnesses/claude/process/types';

export const EXEC_EXIT_CODE = {
	SUCCESS: 0,
	USAGE: 2,
	BOOTSTRAP: 3,
	RUNTIME: 4,
	POLICY: 5,
	TIMEOUT: 6,
	OUTPUT: 7,
} as const;

export type ExecExitCode = (typeof EXEC_EXIT_CODE)[keyof typeof EXEC_EXIT_CODE];

export const EXEC_PERMISSION_POLICIES = ['allow', 'deny', 'fail'] as const;
export const EXEC_QUESTION_POLICIES = ['empty', 'fail'] as const;

export type ExecPermissionPolicy = (typeof EXEC_PERMISSION_POLICIES)[number];
export type ExecQuestionPolicy = (typeof EXEC_QUESTION_POLICIES)[number];

export const EXEC_DEFAULT_PERMISSION_POLICY: ExecPermissionPolicy = 'fail';
export const EXEC_DEFAULT_QUESTION_POLICY: ExecQuestionPolicy = 'fail';

export type ExecRuntimePolicyOptions = {
	onPermission: ExecPermissionPolicy;
	onQuestion: ExecQuestionPolicy;
};

export type ExecRunOptions = {
	prompt: string;
	projectDir: string;
	harness: AthenaHarness;
	instanceId?: number;
	athenaSessionId?: string;
	adapterResumeSessionId?: string;
	isolationConfig: HarnessProcessConfig;
	pluginMcpConfig?: string;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	verbose?: boolean;
	json?: boolean;
	outputLastMessagePath?: string;
	ephemeral?: boolean;
	timeoutMs?: number;
	onPermission: ExecPermissionPolicy;
	onQuestion: ExecQuestionPolicy;
	stdout?: Pick<Writable, 'write'>;
	stderr?: Pick<Writable, 'write'>;
	runtimeFactory?: RuntimeFactory;
	spawnProcess?: (options: SpawnClaudeOptions) => ChildProcess;
	sessionStoreFactory?: (opts: {
		sessionId: string;
		projectDir: string;
		dbPath: string;
		label?: string;
	}) => SessionStore;
	now?: () => number;
};

export type ExecRunFailureKind = 'process' | 'policy' | 'timeout' | 'output';

export type ExecRunFailure = {
	kind: ExecRunFailureKind;
	message: string;
};

export type ExecRunResult = {
	success: boolean;
	exitCode: ExecExitCode;
	athenaSessionId: string | null;
	adapterSessionId: string | null;
	finalMessage: string | null;
	tokens: TokenUsage;
	durationMs: number;
	failure?: ExecRunFailure;
};
