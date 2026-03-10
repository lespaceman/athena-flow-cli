import type {AthenaHarness} from '../../infra/plugins/config';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {
	HarnessProcessConfig,
	HarnessProcessOverride,
	HarnessProcessPreset,
	HarnessProcessOptions,
} from '../../core/runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {UseSessionControllerResult} from '../../harnesses/contracts/session';
import {resolveHarnessAdapter} from '../../harnesses/registry';
import {useRuntime} from '../providers/RuntimeProvider';

export type HarnessProcessResult = UseSessionControllerResult<HarnessProcessOverride> & {
	tokenUsage: TokenUsage;
};

export type UseHarnessProcessInput = {
	harness: AthenaHarness;
	projectDir: string;
	instanceId: number;
	isolation?: HarnessProcessConfig | HarnessProcessPreset;
	pluginMcpConfig?: string;
	verbose?: boolean;
	workflow?: WorkflowConfig;
	options?: HarnessProcessOptions;
};

export function useHarnessProcess(
	input: UseHarnessProcessInput,
): HarnessProcessResult {
	const runtime = useRuntime();
	const adapter = resolveHarnessAdapter(input.harness);
	const controller = adapter.useSessionController({
		projectDir: input.projectDir,
		instanceId: input.instanceId,
		processConfig: input.isolation,
		pluginMcpConfig: input.pluginMcpConfig,
		verbose: input.verbose,
		workflow: input.workflow,
		options: input.options,
		runtime,
	});

	return {
		...controller,
		tokenUsage: controller.usage,
	};
}
