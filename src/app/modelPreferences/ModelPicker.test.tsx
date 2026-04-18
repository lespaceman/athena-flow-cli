import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import ModelPicker from './ModelPicker';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

vi.mock('./listAvailableModels', () => ({
	listAvailableModels: vi.fn(async () => [
		{
			value: 'sonnet',
			label: 'Sonnet',
			description: 'Balanced default',
			isDefault: true,
		},
		{
			value: 'opus',
			label: 'Opus',
			description: 'Stronger reasoning',
		},
	]),
}));

const writeProjectConfigMock = vi.fn();

vi.mock('../../infra/plugins/config', () => ({
	writeProjectConfig: (...args: unknown[]) => writeProjectConfigMock(...args),
}));

describe('ModelPicker', () => {
	it('saves the selected model preference', async () => {
		let selected = '';
		const {stdin, lastFrame} = render(
			<ModelPicker
				projectDir="/project"
				rows={20}
				harness="claude-code"
				runtime={null}
				currentModelName="sonnet"
				onComplete={model => {
					selected = model;
				}}
			/>,
		);

		await vi.waitFor(() => {
			expect(lastFrame()).toContain('Opus');
		});

		stdin.write('\u001B[B');
		await delay(20);
		stdin.write('\r');

		await vi.waitFor(() => {
			expect(writeProjectConfigMock).toHaveBeenCalledWith('/project', {
				model: 'opus',
			});
			expect(selected).toBe('opus');
		});
	});
});
