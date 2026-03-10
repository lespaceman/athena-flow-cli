import {describe, it, expect, vi, beforeEach} from 'vitest';

const resolveMarketplacePluginMock = vi.fn();
const resolveMarketplacePluginFromRepoMock = vi.fn();

vi.mock('../../../infra/plugins/marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	resolveMarketplacePlugin: (ref: string) => resolveMarketplacePluginMock(ref),
	resolveMarketplacePluginFromRepo: (ref: string, repoDir: string) =>
		resolveMarketplacePluginFromRepoMock(ref, repoDir),
}));

const {installWorkflowPlugins} = await import('../installer');

beforeEach(() => {
	resolveMarketplacePluginMock.mockReset();
	resolveMarketplacePluginFromRepoMock.mockReset();
});

describe('installWorkflowPlugins', () => {
	it('resolves all marketplace plugin refs and returns directories', () => {
		resolveMarketplacePluginMock
			.mockReturnValueOnce('/resolved/plugin-a')
			.mockReturnValueOnce('/resolved/plugin-b');

		const result = installWorkflowPlugins({
			name: 'test-workflow',
			plugins: ['plugin-a@owner/repo', 'plugin-b@owner/repo'],
			promptTemplate: '{input}',
		});

		expect(result).toEqual(['/resolved/plugin-a', '/resolved/plugin-b']);
		expect(resolveMarketplacePluginMock).toHaveBeenCalledTimes(2);
	});

	it('throws with specific plugin name on resolution failure', () => {
		resolveMarketplacePluginMock.mockImplementation(() => {
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
		resolveMarketplacePluginFromRepoMock.mockReturnValue('/local/plugin-a');

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
		expect(resolveMarketplacePluginFromRepoMock).toHaveBeenCalledWith(
			'plugin-a@owner/repo',
			'/local/workflow-marketplace',
		);
		expect(resolveMarketplacePluginMock).not.toHaveBeenCalled();
	});
});
