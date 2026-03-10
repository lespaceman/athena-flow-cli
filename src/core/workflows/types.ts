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

export type WorkflowConfig = {
	name: string;
	description?: string;
	version?: string;
	plugins: string[];
	promptTemplate: string;
	loop?: LoopConfig;
	isolation?: string;
	model?: string;
	env?: Record<string, string>;
	/** Path to system prompt file, passed as --append-system-prompt-file */
	systemPromptFile?: string;
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
