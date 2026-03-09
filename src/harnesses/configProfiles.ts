import type {AthenaHarness} from '../infra/plugins/config';
import {resolveClaudeModel} from './claude/config/modelResolver';
import type {
	HarnessProcessConfig,
	HarnessProcessPreset,
} from '../core/runtime/process';

export type BuildHarnessConfigInput = {
	projectDir: string;
	isolationPreset: HarnessProcessPreset;
	additionalDirectories: string[];
	pluginDirs: string[];
	verbose: boolean;
	configuredModel?: string;
};

export type ResolveHarnessModelInput = {
	projectDir: string;
	configuredModel?: string;
};

export type HarnessConfigProfile = {
	harness: AthenaHarness;
	buildIsolationConfig: (
		input: BuildHarnessConfigInput,
	) => HarnessProcessConfig;
	resolveModelName: (input: ResolveHarnessModelInput) => string | null;
};

function buildClaudeCompatibleIsolationConfig({
	isolationPreset,
	additionalDirectories,
	pluginDirs,
	verbose,
	configuredModel,
}: BuildHarnessConfigInput): HarnessProcessConfig {
	return {
		preset: isolationPreset,
		additionalDirectories,
		pluginDirs: pluginDirs.length > 0 ? pluginDirs : undefined,
		debug: verbose,
		model: configuredModel,
	};
}

const CLAUDE_PROFILE: HarnessConfigProfile = {
	harness: 'claude-code',
	buildIsolationConfig: buildClaudeCompatibleIsolationConfig,
	resolveModelName: ({projectDir, configuredModel}) =>
		resolveClaudeModel({projectDir, configuredModel}),
};

function createFallbackProfile(harness: AthenaHarness): HarnessConfigProfile {
	return {
		harness,
		buildIsolationConfig: buildClaudeCompatibleIsolationConfig,
		resolveModelName: ({configuredModel}) => configuredModel ?? null,
	};
}

const PROFILE_BY_HARNESS: Record<AthenaHarness, HarnessConfigProfile> = {
	'claude-code': CLAUDE_PROFILE,
	'openai-codex': {
		harness: 'openai-codex',
		buildIsolationConfig: ({isolationPreset, configuredModel}) => ({
			preset: isolationPreset,
			model: configuredModel,
		}),
		resolveModelName: ({configuredModel}) => configuredModel ?? 'gpt-5.3-codex',
	} satisfies HarnessConfigProfile,
	opencode: createFallbackProfile('opencode'),
};

export function resolveHarnessConfigProfile(
	harness: AthenaHarness,
): HarnessConfigProfile {
	return PROFILE_BY_HARNESS[harness];
}
