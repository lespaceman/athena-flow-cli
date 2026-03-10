import type {Runtime} from '../../core/runtime/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import {resolveHarnessAdapter} from '../../harnesses/registry';

export type RuntimeFactoryInput = {
	harness: AthenaHarness;
	projectDir: string;
	instanceId: number;
};

export type RuntimeFactory = (input: RuntimeFactoryInput) => Runtime;

export const DEFAULT_HARNESS: AthenaHarness = 'claude-code';

export function createRuntime(input: RuntimeFactoryInput): Runtime {
	return resolveHarnessAdapter(input.harness).createRuntime({
		projectDir: input.projectDir,
		instanceId: input.instanceId,
	});
}
