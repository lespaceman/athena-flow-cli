/**
 * Workflow configuration — loaded from workflow.json.
 *
 * Workflows live in ~/.config/athena/workflows/{name}/workflow.json
 * and orchestrate multiple plugins via marketplace refs.
 */

export type LoopConfig = {
	enabled: boolean;
	/**
	 * Substring that signals the workflow completed successfully.
	 * Defaults to `<!-- WORKFLOW_COMPLETE -->` when omitted.
	 */
	completionMarker?: string;
	maxIterations: number;
	/**
	 * Prefix that signals the workflow is blocked.
	 * Defaults to `<!-- WORKFLOW_BLOCKED` when omitted.
	 */
	blockedMarker?: string;
	/**
	 * Relative path to the tracker file. Supports `{sessionId}` substitution.
	 * Defaults to `.athena/{sessionId}/tracker.md` when omitted.
	 */
	trackerPath?: string;
	/** Prompt template for iterations 2+; supports {trackerPath} placeholder */
	continuePrompt?: string;
};

/**
 * Terminal reasons for a workflow loop.
 *
 * The runner uses this to distinguish a clean completion from an execution
 * problem such as the tracker file disappearing.
 */
export type LoopStopReason =
	| 'completed'
	| 'blocked'
	| 'max_iterations'
	| 'missing_tracker';

/**
 * A plugin dependency with an explicit version pin.
 * Used in workflows to lock a specific plugin version.
 */
export type PluginDependency = {
	ref: string;
	version: string;
};

/**
 * A plugin specifier: either a bare marketplace ref string (resolves to latest)
 * or a structured dependency with a pinned version.
 */
export type PluginSpec = string | PluginDependency;

/** Extract the marketplace ref from a PluginSpec. */
export function pluginSpecRef(spec: PluginSpec): string {
	return typeof spec === 'string' ? spec : spec.ref;
}

/** Extract the pinned version from a PluginSpec, if any. */
export function pluginSpecVersion(spec: PluginSpec): string | undefined {
	return typeof spec === 'string' ? undefined : spec.version;
}

export type WorkflowConfig = {
	name: string;
	description?: string;
	version?: string;
	plugins: PluginSpec[];
	promptTemplate: string;
	loop?: LoopConfig;
	isolation?: string;
	model?: string;
	env?: Record<string, string>;
	/** Path to workflow orchestration doc, passed as --append-system-prompt-file */
	workflowFile?: string;
	/** Example prompts shown in the empty-state onboarding screen */
	examplePrompts?: string[];
};

export type WorkflowSourceMetadata =
	| {kind: 'marketplace-remote'; ref: string; version?: string}
	| {
			kind: 'marketplace-local';
			repoDir: string;
			workflowName: string;
			version?: string;
	  }
	| {kind: 'filesystem'; path: string};

export type ResolvedWorkflowConfig = WorkflowConfig & {
	__source?: WorkflowSourceMetadata;
};

export type ResolvedWorkflowPlugin = {
	ref: string;
	pluginName: string;
	marketplaceName: string;
	version?: string;
	pluginDir: string;
	claudeArtifactDir: string;
	codexPluginDir: string;
	codexMarketplacePath: string;
};

export type ResolvedLocalWorkflowPlugin = {
	ref: string;
	pluginDir: string;
};

export type CodexWorkflowPluginRef = {
	ref: string;
	pluginName: string;
	marketplacePath: string;
};

/**
 * Terminal and non-terminal states for a workflow run.
 */
export type RunStatus =
	| 'running'
	| 'completed'
	| 'blocked'
	| 'exhausted'
	| 'failed'
	| 'cancelled';
