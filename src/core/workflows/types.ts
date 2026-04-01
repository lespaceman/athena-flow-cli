/**
 * Workflow configuration — loaded from workflow.json.
 *
 * Workflows live in ~/.config/athena/workflows/{name}/workflow.json
 * and orchestrate multiple plugins via marketplace refs.
 */

export type LoopConfig = {
	enabled: boolean;
	completionMarker: string;
	maxIterations: number;
	/** Optional prefix to detect blocked state (e.g. "<!-- E2E_BLOCKED") */
	blockedMarker?: string;
	/** Relative path to tracker file in project root (e.g. "e2e-tracker.md") */
	trackerPath?: string;
	/** Prompt template for iterations 2+; supports {trackerPath} placeholder */
	continuePrompt?: string;
};

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
	/** Path to system prompt file, passed as --append-system-prompt-file */
	systemPromptFile?: string;
	/** Example prompts shown in the empty-state onboarding screen */
	examplePrompts?: string[];
};

export type WorkflowSourceMetadata =
	| {
			kind: 'marketplace';
			ref: string;
	  }
	| {
			kind: 'local';
			path: string;
			repoDir?: string;
	  };

export type ResolvedWorkflowConfig = WorkflowConfig & {
	__source?: WorkflowSourceMetadata;
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
