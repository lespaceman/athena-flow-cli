import type {Runtime} from '../../core/runtime/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {CodexRuntimeModel} from '../../harnesses/codex/runtime/server';

export type HarnessModelOption = {
	value: string;
	label: string;
	description: string;
	isDefault?: boolean;
};

type CodexRuntimeWithModels = Runtime & {
	listModels: () => Promise<CodexRuntimeModel[]>;
};

const CLAUDE_MODEL_OPTIONS: HarnessModelOption[] = [
	{
		value: 'sonnet',
		label: 'Sonnet',
		description: 'Balanced default for day-to-day coding work.',
	},
	{
		value: 'opus',
		label: 'Opus',
		description: 'Stronger reasoning for complex architecture and debugging.',
	},
	{
		value: 'haiku',
		label: 'Haiku',
		description: 'Fastest option for lighter tasks.',
	},
	{
		value: 'opusplan',
		label: 'OpusPlan',
		description: 'Uses Opus for planning and Sonnet for execution.',
	},
];

function isCodexRuntimeWithModels(
	runtime: Runtime | null | undefined,
): runtime is CodexRuntimeWithModels {
	return Boolean(runtime && 'listModels' in runtime);
}

export async function listAvailableModels(input: {
	harness: AthenaHarness;
	runtime?: Runtime | null;
}): Promise<HarnessModelOption[]> {
	switch (input.harness) {
		case 'claude-code':
			return CLAUDE_MODEL_OPTIONS;
		case 'openai-codex': {
			if (!isCodexRuntimeWithModels(input.runtime)) {
				throw new Error('Codex runtime is not available');
			}
			const models = await input.runtime.listModels();
			return models.map(model => ({
				value: model.model,
				label: model.displayName,
				description: model.description,
				isDefault: model.isDefault,
			}));
		}
		case 'opencode':
		default:
			return [];
	}
}
