import type {AthenaHarness} from '../infra/plugins/config';
import type {
	BuildHarnessConfigInput,
	HarnessConfigProfile,
	ResolveHarnessModelInput,
} from './contracts/config';
import {resolveHarnessAdapter} from './registry';

export type {
	BuildHarnessConfigInput,
	HarnessConfigProfile,
	ResolveHarnessModelInput,
};

export function resolveHarnessConfigProfile(
	harness: AthenaHarness,
): HarnessConfigProfile {
	return resolveHarnessAdapter(harness).resolveConfigProfile();
}
