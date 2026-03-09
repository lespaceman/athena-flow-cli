import type {AthenaHarness} from '../infra/plugins/config';
import {verifyClaudeHarness} from './claude/system/verifyHarness';
import {verifyCodexHarness} from './codex/system/verifyHarness';
import type {HarnessVerificationResult} from './types';

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
		label: 'OpenAI Codex',
		enabled: true,
		verify: () => verifyCodexHarness(),
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
