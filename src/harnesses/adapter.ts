import type {Runtime} from '../core/runtime/types';
import type {WorkflowConfig} from '../core/workflows/types';
import type {AthenaHarness} from '../infra/plugins/config';
import type {HarnessConfigProfile} from './contracts/config';
import type {
	CreateSessionController,
	UseSessionController,
} from './contracts/session';
import type {HarnessVerificationResult} from './types';

export type HarnessRuntimeFactoryInput = {
	projectDir: string;
	instanceId: number;
	workflow?: WorkflowConfig;
};

export type HarnessAdapter = {
	id: AthenaHarness;
	label: string;
	enabled: boolean;
	verify?: () => HarnessVerificationResult;
	createRuntime: (input: HarnessRuntimeFactoryInput) => Runtime;
	createSessionController: CreateSessionController;
	useSessionController: UseSessionController;
	resolveConfigProfile: () => HarnessConfigProfile;
};
