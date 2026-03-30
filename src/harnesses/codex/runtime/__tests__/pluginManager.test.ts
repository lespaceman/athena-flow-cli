import {describe, expect, it, vi} from 'vitest';
import {
	buildCodexPluginInstallMessage,
	ensureCodexWorkflowPluginsInstalled,
} from '../pluginManager';

describe('ensureCodexWorkflowPluginsInstalled', () => {
	it('lists marketplaces for cwd and installs each workflow plugin target', async () => {
		const sendRequest = vi.fn().mockResolvedValue({});
		const manager = {
			sendRequest,
		};

		const result = await ensureCodexWorkflowPluginsInstalled({
			manager: manager as never,
			projectDir: '/workspace/project',
			pluginTargets: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
					pluginDir: '/cache/repo/plugins/plugin-a',
				},
			],
		});

		expect(sendRequest).toHaveBeenNthCalledWith(1, 'plugin/list', {
			cwds: ['/workspace/project'],
		});
		expect(sendRequest).toHaveBeenNthCalledWith(2, 'plugin/install', {
			marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(result).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			},
		]);
	});
});

describe('buildCodexPluginInstallMessage', () => {
	it('formats an installation summary', () => {
		expect(
			buildCodexPluginInstallMessage([
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			]),
		).toContain('plugin-a');
	});
});
