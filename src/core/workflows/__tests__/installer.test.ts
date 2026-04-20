import {describe, it, expect, vi, beforeEach} from 'vitest';

const resolveMarketplacePluginTargetMock = vi.fn();
const resolveMarketplacePluginTargetFromRepoMock = vi.fn();
const refreshVersionedMarketplacePluginTargetMock = vi.fn();

vi.mock('../../../infra/plugins/marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	refreshVersionedMarketplacePluginTarget: (
		ref: string,
		version: string,
		sourceRepoDir?: string,
	) => refreshVersionedMarketplacePluginTargetMock(ref, version, sourceRepoDir),
	resolveMarketplacePluginTarget: (ref: string) =>
		resolveMarketplacePluginTargetMock(ref),
	resolveMarketplacePluginTargetFromRepo: (ref: string, repoDir: string) =>
		resolveMarketplacePluginTargetFromRepoMock(ref, repoDir),
	resolveVersionedMarketplacePluginTarget: (ref: string, version: string) =>
		resolveMarketplacePluginTargetMock(ref, version),
}));

const {
	installWorkflowPlugins,
	refreshPinnedWorkflowPlugins,
	resolveWorkflowPlugins,
} = await import('../installer');

beforeEach(() => {
	resolveMarketplacePluginTargetMock.mockReset();
	resolveMarketplacePluginTargetFromRepoMock.mockReset();
	refreshVersionedMarketplacePluginTargetMock.mockReset();
});

describe('installWorkflowPlugins', () => {
	it('resolves all marketplace plugin refs and returns directories', () => {
		resolveMarketplacePluginTargetMock
			.mockReturnValueOnce({
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplacePath: '/repo/.agents/plugins/marketplace.json',
				pluginDir: '/resolved/plugin-a',
				codexPluginDir: '/resolved/plugin-a',
			})
			.mockReturnValueOnce({
				ref: 'plugin-b@owner/repo',
				pluginName: 'plugin-b',
				marketplacePath: '/repo/.agents/plugins/marketplace.json',
				pluginDir: '/resolved/plugin-b',
				codexPluginDir: '/resolved/plugin-b',
			});

		const result = installWorkflowPlugins({
			name: 'test-workflow',
			plugins: ['plugin-a@owner/repo', 'plugin-b@owner/repo'],
			promptTemplate: '{input}',
		});

		expect(result).toEqual(['/resolved/plugin-a', '/resolved/plugin-b']);
		expect(resolveMarketplacePluginTargetMock).toHaveBeenCalledTimes(2);
	});

	it('throws with specific plugin name on resolution failure', () => {
		resolveMarketplacePluginTargetMock.mockImplementation(() => {
			throw new Error('Plugin not found');
		});

		expect(() =>
			installWorkflowPlugins({
				name: 'test-workflow',
				plugins: ['bad-plugin@owner/repo'],
				promptTemplate: '{input}',
			}),
		).toThrow(/bad-plugin@owner\/repo/);
	});

	it('returns empty array when plugins list is empty', () => {
		const result = installWorkflowPlugins({
			name: 'test-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});

		expect(result).toEqual([]);
	});

	it('resolves plugin refs from the local source repo when available', () => {
		resolveMarketplacePluginTargetFromRepoMock.mockReturnValue({
			ref: 'plugin-a@owner/repo',
			pluginName: 'plugin-a',
			marketplacePath:
				'/local/workflow-marketplace/.agents/plugins/marketplace.json',
			pluginDir: '/local/plugin-a',
			codexPluginDir: '/local/plugin-a',
		});

		const result = installWorkflowPlugins({
			name: 'test-workflow',
			plugins: ['plugin-a@owner/repo'],
			promptTemplate: '{input}',
			__source: {
				kind: 'marketplace-local',
				repoDir: '/local/workflow-marketplace',
				workflowName: 'test-workflow',
			},
		});

		expect(result).toEqual(['/local/plugin-a']);
		expect(resolveMarketplacePluginTargetFromRepoMock).toHaveBeenCalledWith(
			'plugin-a@owner/repo',
			'/local/workflow-marketplace',
		);
		expect(resolveMarketplacePluginTargetMock).not.toHaveBeenCalled();
	});
});

describe('resolveWorkflowPlugins', () => {
	it('returns both local plugins and codex plugin refs in a single pass', () => {
		resolveMarketplacePluginTargetMock.mockReturnValue({
			ref: 'plugin-a@owner/repo',
			pluginName: 'plugin-a',
			marketplacePath: '/repo/.agents/plugins/marketplace.json',
			pluginDir: '/resolved/plugin-a',
			codexPluginDir: '/resolved/plugin-a',
		});

		const result = resolveWorkflowPlugins({
			name: 'test-workflow',
			plugins: ['plugin-a@owner/repo'],
			promptTemplate: '{input}',
		});

		expect(result.localPlugins).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginDir: '/resolved/plugin-a',
			},
		]);
		expect(result.resolvedPlugins).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplaceName: 'owner/repo',
				pluginDir: '/resolved/plugin-a',
				claudeArtifactDir: '/resolved/plugin-a',
				codexPluginDir: '/resolved/plugin-a',
				codexMarketplacePath: '/repo/.agents/plugins/marketplace.json',
			},
		]);
		expect(result.codexPlugins).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplacePath: '/repo/.agents/plugins/marketplace.json',
			},
		]);
		// Single pass — resolver called once, not twice.
		expect(resolveMarketplacePluginTargetMock).toHaveBeenCalledTimes(1);
	});

	it('preserves pinned versions for Codex-native plugin installs', () => {
		resolveMarketplacePluginTargetMock.mockReturnValue({
			ref: 'plugin-a@owner/repo',
			pluginName: 'plugin-a',
			marketplacePath:
				'/cache/plugin-packages/owner/repo/plugin-a/1.2.3/.agents/plugins/marketplace.json',
			pluginDir: '/resolved/plugin-a',
			codexPluginDir: '/resolved/plugin-a',
		});

		const result = resolveWorkflowPlugins({
			name: 'test-workflow',
			plugins: [{ref: 'plugin-a@owner/repo', version: '1.2.3'}],
			promptTemplate: '{input}',
		});

		expect(result.codexPlugins).toEqual([
			{
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplacePath:
					'/cache/plugin-packages/owner/repo/plugin-a/1.2.3/.agents/plugins/marketplace.json',
				version: '1.2.3',
			},
		]);
	});
});

describe('refreshPinnedWorkflowPlugins', () => {
	it('refreshes only pinned plugins', () => {
		refreshPinnedWorkflowPlugins({
			name: 'test-workflow',
			plugins: [
				'latest-plugin@owner/repo',
				{ref: 'pinned-plugin@owner/repo', version: '1.2.3'},
			],
			promptTemplate: '{input}',
		});

		expect(refreshVersionedMarketplacePluginTargetMock).toHaveBeenCalledTimes(
			1,
		);
		expect(refreshVersionedMarketplacePluginTargetMock).toHaveBeenCalledWith(
			'pinned-plugin@owner/repo',
			'1.2.3',
			undefined,
		);
	});

	it('uses the local source repo for pinned plugin refreshes', () => {
		refreshPinnedWorkflowPlugins({
			name: 'test-workflow',
			plugins: [{ref: 'pinned-plugin@owner/repo', version: '1.2.3'}],
			promptTemplate: '{input}',
			__source: {
				kind: 'marketplace-local',
				repoDir: '/local/workflow-marketplace',
				workflowName: 'test-workflow',
			},
		});

		expect(refreshVersionedMarketplacePluginTargetMock).toHaveBeenCalledWith(
			'pinned-plugin@owner/repo',
			'1.2.3',
			'/local/workflow-marketplace',
		);
	});
});
