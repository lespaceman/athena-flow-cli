import {describe, expect, it, vi} from 'vitest';
import {listAvailableModels} from './listAvailableModels';

describe('listAvailableModels', () => {
	it('returns the built-in Claude model options', async () => {
		await expect(
			listAvailableModels({harness: 'claude-code'}),
		).resolves.toEqual([
			expect.objectContaining({value: 'sonnet', label: 'Sonnet'}),
			expect.objectContaining({value: 'opus', label: 'Opus'}),
			expect.objectContaining({value: 'haiku', label: 'Haiku'}),
			expect.objectContaining({value: 'opusplan', label: 'OpusPlan'}),
		]);
	});

	it('uses the active Codex runtime to fetch models', async () => {
		const runtime = {
			listModels: vi.fn().mockResolvedValue([
				{
					id: 'm1',
					model: 'gpt-5.4',
					displayName: 'GPT-5.4',
					description: 'Latest frontier agentic coding model.',
					hidden: false,
					isDefault: true,
				},
			]),
		};

		await expect(
			listAvailableModels({
				harness: 'openai-codex',
				runtime: runtime as never,
			}),
		).resolves.toEqual([
			{
				value: 'gpt-5.4',
				label: 'GPT-5.4',
				description: 'Latest frontier agentic coding model.',
				isDefault: true,
			},
		]);
		expect(runtime.listModels).toHaveBeenCalledTimes(1);
	});
});
