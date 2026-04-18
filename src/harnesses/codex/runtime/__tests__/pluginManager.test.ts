import {describe, expect, it, vi} from 'vitest';
import {
	buildCodexPluginInstallMessage,
	ensureCodexWorkflowPluginsInstalled,
} from '../workflowPluginLifecycle';

describe('ensureCodexWorkflowPluginsInstalled', () => {
	it('installs each missing workflow plugin directly from its resolved marketplace path', async () => {
		const sendRequest = vi
			.fn()
			.mockResolvedValueOnce({
				plugin: {
					summary: {
						installed: false,
					},
				},
			})
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				plugin: {
					marketplaceName: 'athena-workflow-marketplace',
					summary: {
						installed: true,
					},
				},
			});
		const manager = {
			sendRequest,
		};

		const result = await ensureCodexWorkflowPluginsInstalled({
			manager: manager as never,
			projectDir: '/workspace/project',
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
		});

		expect(sendRequest).toHaveBeenCalledTimes(3);
		expect(sendRequest).toHaveBeenNthCalledWith(1, 'plugin/read', {
			marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(sendRequest).toHaveBeenNthCalledWith(2, 'plugin/install', {
			marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(sendRequest).toHaveBeenNthCalledWith(3, 'plugin/read', {
			marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(result).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplaceName: 'athena-workflow-marketplace',
				marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			},
		]);
	});

	it('still installs workflow plugins when plugin/read works for Athena cached marketplace paths', async () => {
		const manager = {
			sendRequest: vi
				.fn()
				.mockResolvedValueOnce({
					plugin: {
						summary: {
							installed: false,
						},
					},
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					plugin: {
						marketplaceName: 'athena-workflow-marketplace',
						summary: {
							installed: true,
						},
					},
				}),
		};

		await expect(
			ensureCodexWorkflowPluginsInstalled({
				manager: manager as never,
				projectDir: '/workspace/project',
				plugins: [
					{
						ref: 'plugin-a@owner/repo',
						pluginName: 'plugin-a',
						marketplacePath:
							'/Users/nadeem/.config/athena/marketplaces/owner/repo/.agents/plugins/marketplace.json',
					},
				],
			}),
		).resolves.toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplaceName: 'athena-workflow-marketplace',
				marketplacePath:
					'/Users/nadeem/.config/athena/marketplaces/owner/repo/.agents/plugins/marketplace.json',
			},
		]);
		expect(manager.sendRequest).toHaveBeenCalledTimes(3);
		expect(manager.sendRequest).toHaveBeenNthCalledWith(1, 'plugin/read', {
			marketplacePath:
				'/Users/nadeem/.config/athena/marketplaces/owner/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(manager.sendRequest).toHaveBeenNthCalledWith(2, 'plugin/install', {
			marketplacePath:
				'/Users/nadeem/.config/athena/marketplaces/owner/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(manager.sendRequest).toHaveBeenNthCalledWith(3, 'plugin/read', {
			marketplacePath:
				'/Users/nadeem/.config/athena/marketplaces/owner/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
	});

	it('skips plugin/install when the plugin is already installed according to plugin/read', async () => {
		const sendRequest = vi.fn().mockResolvedValue({
			plugin: {
				marketplaceName: 'athena-workflow-marketplace',
				summary: {
					installed: true,
				},
			},
		});
		const manager = {
			sendRequest,
		};

		const result = await ensureCodexWorkflowPluginsInstalled({
			manager: manager as never,
			projectDir: '/workspace/project',
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
		});

		expect(sendRequest).toHaveBeenCalledTimes(1);
		expect(sendRequest).toHaveBeenNthCalledWith(1, 'plugin/read', {
			marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			pluginName: 'plugin-a',
		});
		expect(sendRequest).not.toHaveBeenCalledWith(
			'plugin/install',
			expect.anything(),
		);
		expect(result).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplaceName: 'athena-workflow-marketplace',
				marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
			},
		]);
	});

	it('fails when plugin/read does not report the plugin as installed after plugin/install', async () => {
		const manager = {
			sendRequest: vi
				.fn()
				.mockResolvedValueOnce({
					plugin: {
						summary: {
							installed: false,
						},
					},
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					plugin: {
						summary: {
							installed: false,
						},
					},
				}),
		};

		await expect(
			ensureCodexWorkflowPluginsInstalled({
				manager: manager as never,
				projectDir: '/workspace/project',
				plugins: [
					{
						ref: 'plugin-a@owner/repo',
						pluginName: 'plugin-a',
						marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
					},
				],
			}),
		).rejects.toThrow(/did not report workflow plugin as installed/i);
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
