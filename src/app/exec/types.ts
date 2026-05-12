import type {ChildProcess} from 'node:child_process';
import type {Writable} from 'node:stream';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {SessionStore} from '../../infra/sessions/store';
import type {RuntimeFactory} from '../runtime/createRuntime';
import type {SpawnClaudeOptions} from '../../harnesses/claude/process/types';
import type {SessionBridge} from '../channels/sessionBridge';
import type {StartSessionBridgeOptions} from '../channels/sessionBridgeLifecycle';
import type {
	DashboardFeedOrigin,
	DashboardFeedPublisher,
} from '../dashboard/dashboardFeedPublisher';

export const EXEC_EXIT_CODE = {
	SUCCESS: 0,
	USAGE: 2,
	BOOTSTRAP: 3,
	RUNTIME: 4,
	// 5 was POLICY (removed when exec dropped --on-permission/--on-question);
	// the slot is intentionally left as a numeric gap to keep external scripts
	// that special-case 5 from getting a new meaning.
	TIMEOUT: 6,
	OUTPUT: 7,
	WORKFLOW_BLOCKED: 8,
	WORKFLOW_EXHAUSTED: 9,
} as const;

export type ExecExitCode = (typeof EXEC_EXIT_CODE)[keyof typeof EXEC_EXIT_CODE];

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
	signal?: AbortSignal;
	/**
	 * Channel ids passed via `--channel`. When non-empty, exec connects to the
	 * gateway daemon and relays permission/question requests through it. When
	 * empty, exec runs without a bridge — permission requests block until
	 * `timeoutMs` (or forever if no timeout).
	 */
	channels?: readonly string[];
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
	dashboardFeedPublisher?: DashboardFeedPublisher;
	dashboardOrigin?: DashboardFeedOrigin;
	/** Test seam: override the gateway connect step. */
	bridgeFactory?: (
		opts: StartSessionBridgeOptions,
	) => Promise<SessionBridge | null>;
	now?: () => number;
};

export type ExecWorkflowFailureState =
	| 'blocked'
	| 'exhausted'
	| 'missing_tracker';

export type ExecRunFailure =
	| {
			kind: 'process' | 'timeout' | 'output';
			message: string;
	  }
	| {
			kind: 'workflow';
			state: ExecWorkflowFailureState;
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
