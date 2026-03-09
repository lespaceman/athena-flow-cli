import type {TokenUsage} from '../../shared/types/headerMetrics';

export type HarnessProcessLifecycleEvent =
	| {
			type: 'spawn_error';
			message: string;
	  }
	| {
			type: 'exit_nonzero';
			code: number;
			message: string;
	  };

/**
 * Harness-agnostic process lifecycle contract for prompt execution.
 */
export type HarnessProcess<ConfigOverride = unknown> = {
	isRunning: boolean;
	spawn: (
		prompt: string,
		sessionId?: string,
		configOverride?: ConfigOverride,
	) => Promise<void>;
	interrupt: () => void;
	kill: () => Promise<void>;
	usage: TokenUsage;
};

/**
 * Harness-neutral preset key used for process/runtime config profiles.
 */
export type HarnessProcessPreset = 'strict' | 'minimal' | 'permissive';

/**
 * Harness-neutral process configuration shape used at app boundaries.
 *
 * Harness adapters may read additional fields via index signature.
 */
export type HarnessProcessConfig = {
	preset?: HarnessProcessPreset;
	additionalDirectories?: string[];
	pluginDirs?: string[];
	allowedTools?: string[];
	model?: string;
	debug?: string | boolean;
	[key: string]: unknown;
};

/**
 * Per-command process overrides (for prompt commands and workflow injections).
 */
export type HarnessProcessOverride = Record<string, unknown>;

/**
 * Harness-neutral process hook options shared by adapters.
 */
export type HarnessProcessOptions = {
	initialTokens?: TokenUsage | null;
	onExitTokens?: (tokens: TokenUsage) => void;
	onLifecycleEvent?: (event: HarnessProcessLifecycleEvent) => void;
	trackOutput?: boolean;
	trackStreamingText?: boolean;
	tokenUpdateMs?: number;
	tokenParserFactory?: TokenUsageParserFactory;
};

/**
 * Strategy contract for parsing token usage from harness stdout streams.
 */
export type TokenUsageParser = {
	feed: (chunk: string) => void;
	flush: () => void;
	getUsage: () => TokenUsage;
	reset: () => void;
};

/**
 * Factory for creating parser instances per process hook lifecycle.
 */
export type TokenUsageParserFactory = () => TokenUsageParser;
