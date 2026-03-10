import type {AthenaHarness} from '../../infra/plugins/config';
import type {
	HarnessProcessConfig,
	HarnessProcessPreset,
} from '../../core/runtime/process';

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
