import type {AthenaHarness} from '../infra/plugins/config';
import {
	type HarnessVerificationResult,
	verifyClaudeHarness,
} from './claude/system/verifyHarness';

export type HarnessCapability = {
	id: AthenaHarness;
	label: string;
	enabled: boolean;
	verify?: () => HarnessVerificationResult;
};

const HARNESS_CAPABILITIES: HarnessCapability[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		enabled: true,
		verify: () => verifyClaudeHarness(),
	},
	{
		id: 'openai-codex',
		label: 'OpenAI Codex (coming soon)',
		enabled: false,
	},
	{
		id: 'opencode',
		label: 'OpenCode (coming soon)',
		enabled: false,
	},
];

export function listHarnessCapabilities(): HarnessCapability[] {
	return HARNESS_CAPABILITIES;
}
