import type {AthenaHarness} from '../../infra/plugins/config';

export function normalizeHarnessOverride(
	value: unknown,
): AthenaHarness | undefined {
	switch (value) {
		case 'claude':
		case 'claude-code':
			return 'claude-code';
		case 'codex':
		case 'openai-codex':
			return 'openai-codex';
		case 'opencode':
			return 'opencode';
		default:
			return undefined;
	}
}
