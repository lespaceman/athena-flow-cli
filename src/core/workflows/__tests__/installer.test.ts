import {describe, it, expect, vi, beforeEach} from 'vitest';

const resolveMarketplacePluginTargetMock = vi.fn();
const resolveMarketplacePluginTargetFromRepoMock = vi.fn();

vi.mock('../../../infra/plugins/marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	resolveMarketplacePluginTarget: (ref: string) =>
		resolveMarketplacePluginTargetMock(ref),
	resolveMarketplacePluginTargetFromRepo: (ref: string, repoDir: string) =>
		resolveMarketplacePluginTargetFromRepoMock(ref, repoDir),
	resolveVersionedMarketplacePluginTarget: (ref: string, version: string) =>
		resolveMarketplacePluginTargetMock(ref, version),
}));

const {installWorkflowPlugins, resolveWorkflowPlugins} =
	await import('../installer');

beforeEach(() => {
	resolveMarketplacePluginTargetMock.mockReset();
	resolveMarketplacePluginTargetFromRepoMock.mockReset();
});

describe('installWorkflowPlugins', () => {
	it('resolves all marketplace plugin refs and returns directories', () => {
		resolveMarketplacePluginTargetMock
			.mockReturnValueOnce({
				ref: 'plugin-a@owner/repo',
				pluginName: 'plugin-a',
				marketplacePath: '/repo/.agents/plugins/marketplace.json',
				pluginDir: '/resolved/plugin-a',
			})
			.mockReturnValueOnce({
				ref: 'plugin-b@owner/repo',
				pluginName: 'plugin-b',
				marketplacePath: '/repo/.agents/plugins/marketplace.json',
				pluginDir: '/resolved/plugin-b',
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
		});

		const result = installWorkflowPlugins({
			name: 'test-workflow',
			plugins: ['plugin-a@owner/repo'],
			promptTemplate: '{input}',
			__source: {
				kind: 'local',
				path: '/tmp/workflow.json',
				repoDir: '/local/workflow-marketplace',
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
});
