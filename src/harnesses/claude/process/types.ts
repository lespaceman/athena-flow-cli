/**
 * Claude process types.
 *
 * Types for spawning and managing Claude Code headless processes.
 */

import {type IsolationConfig, type IsolationPreset} from '../config/isolation';
import type {TokenUsage} from '../../../shared/types/headerMetrics';
import type {
	TurnContinuation,
	TurnExecutionResult,
} from '../../../core/runtime/process';

/**
 * Options for spawning a Claude Code headless process.
 */
export type SpawnClaudeOptions = {
	/** The prompt to send to Claude */
	prompt: string;
	/** Project directory used as cwd for the Claude process */
	projectDir: string;
	/** Instance ID of the athena-cli process (used for socket routing) */
	instanceId: number;
	/** Optional session ID to resume an existing conversation */
	sessionId?: string;
	/**
	 * Isolation configuration for the spawned Claude process.
	 * Controls which settings/hooks/MCP servers are loaded.
	 * Defaults to 'strict' preset (user settings only, athena hooks injected).
	 */
	isolation?: IsolationConfig | IsolationPreset;
	/** Additional environment variables to pass to the Claude process */
	env?: Record<string, string>;
	/** Called when stdout data is received */
	onStdout?: (data: string) => void;
	/** Called when stderr data is received */
	onStderr?: (data: string) => void;
	/** Called when the process exits */
	onExit?: (code: number | null) => void;
	/** Called when spawn fails (e.g., claude command not found) */
	onError?: (error: Error) => void;
	/** jq filter expression applied to stdout via a sidecar process */
	jqFilter?: string;
	/** Called when jq-filtered stdout data is received */
	onFilteredStdout?: (data: string) => void;
	/** Called when jq writes to stderr (parse errors, etc.) */
	onJqStderr?: (data: string) => void;
};

/**
 * Result returned by the useClaudeProcess hook.
 */
export type UseClaudeProcessResult = {
	spawn: (
		prompt: string,
		continuation?: TurnContinuation,
		isolation?: Partial<IsolationConfig>,
	) => Promise<TurnExecutionResult>;
	isRunning: boolean;
	output: string[];
	kill: () => Promise<void>;
	/** Send SIGINT to gracefully interrupt the running process */
	sendInterrupt: () => void;
	/** Accumulated assistant text from jq-filtered stdout (debug mode) */
	streamingText: string;
	/** Live token usage parsed from stream-json stdout */
	tokenUsage: TokenUsage;
};
