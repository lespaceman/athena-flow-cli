import {describe, it, expect, vi, beforeEach} from 'vitest';

const files: Record<string, string> = {};
const dirs: Set<string> = new Set();
const refreshPinnedWorkflowPluginsMock = vi.fn();

vi.mock('node:fs', () => ({
	default: {
		existsSync: (p: string) => p in files || dirs.has(p),
		readFileSync: (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		mkdirSync: () => {
			/* noop */
		},
		writeFileSync: (p: string, content: string) => {
			files[p] = content;
		},
		copyFileSync: (from: string, to: string) => {
			if (!(from in files)) throw new Error(`ENOENT: ${from}`);
			files[to] = files[from]!;
		},
		rmSync: (p: string) => {
			delete files[p];
			dirs.delete(p);
		},
		readdirSync: (dir: string, opts?: {withFileTypes: boolean}) => {
			if (!opts?.withFileTypes) return [];
			const prefix = dir.endsWith('/') ? dir : dir + '/';
			const entries = new Set<string>();
			for (const key of [...Object.keys(files), ...dirs]) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const name = rest.split('/')[0];
					if (name) entries.add(name!);
				}
			}
			return [...entries].map(name => ({
				name,
				isDirectory: () => true,
			}));
		},
	},
}));

vi.mock('node:os', () => ({
	default: {
		homedir: () => '/home/testuser',
	},
}));

vi.mock('../../../infra/plugins/marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	findMarketplaceRepoDir: () => undefined,
	resolveMarketplaceWorkflow: () => '/tmp/resolved-workflow.json',
}));

vi.mock('../builtins/index', () => ({
	resolveBuiltinWorkflow: () => undefined,
	listBuiltinWorkflows: () => [],
}));

vi.mock('../installer', () => ({
	refreshPinnedWorkflowPlugins: (workflow: unknown) =>
		refreshPinnedWorkflowPluginsMock(workflow),
}));

const {
	resolveWorkflow,
	installWorkflow,
	installWorkflowFromSource,
	updateWorkflow,
	listWorkflows,
	removeWorkflow,
} = await import('../registry');

beforeEach(() => {
	for (const key of Object.keys(files)) {
		delete files[key];
	}
	dirs.clear();
	refreshPinnedWorkflowPluginsMock.mockReset();
});

describe('resolveWorkflow', () => {
	it('resolves a workflow by name from the registry', () => {
		const workflow = {
			name: 'e2e-testing',
			plugins: ['test-builder@owner/repo'],
			promptTemplate: 'Use /test {input}',
			workflowFile: 'workflow.md',
		};
		files['/home/testuser/.config/athena/workflows/e2e-testing/workflow.json'] =
			JSON.stringify(workflow);
		files['/home/testuser/.config/athena/workflows/e2e-testing/workflow.md'] =
			'# Workflow';

		const result = resolveWorkflow('e2e-testing');

		expect(result).toEqual({
			...workflow,
			workflowFile:
				'/home/testuser/.config/athena/workflows/e2e-testing/workflow.md',
		});
	});

	it('attaches local source repo metadata when installed from a local marketplace checkout', () => {
		const workflow = {
			name: 'local-marketplace',
			plugins: ['plugin@owner/repo'],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		};
		files[
			'/home/testuser/.config/athena/workflows/local-marketplace/workflow.json'
		] = JSON.stringify(workflow);
		files[
			'/home/testuser/.config/athena/workflows/local-marketplace/workflow.md'
		] = '# Workflow';
		files[
			'/home/testuser/.config/athena/workflows/local-marketplace/source.json'
		] = JSON.stringify({
			kind: 'local',
			path: '/tmp/workflow-marketplace/workflows/local-marketplace/workflow.json',
			repoDir: '/tmp/workflow-marketplace',
		});
		files[
			'/tmp/workflow-marketplace/workflows/local-marketplace/workflow.json'
		] = JSON.stringify(workflow);
		files['/tmp/workflow-marketplace/workflows/local-marketplace/workflow.md'] =
			'# Workflow';

		const result = resolveWorkflow('local-marketplace');

		expect(result.__source).toEqual({
			kind: 'filesystem',
			path: '/tmp/workflow-marketplace/workflows/local-marketplace/workflow.json',
		});
	});

	it('does not silently re-sync local workflow content on resolve', () => {
		files['/home/testuser/.config/athena/workflows/local-copy/workflow.json'] =
			JSON.stringify({
				name: 'local-copy',
				plugins: [],
				promptTemplate: 'installed snapshot',
				workflowFile: 'workflow.md',
			});
		files['/home/testuser/.config/athena/workflows/local-copy/workflow.md'] =
			'# Installed Workflow';
		files['/home/testuser/.config/athena/workflows/local-copy/source.json'] =
			JSON.stringify({
				kind: 'local',
				path: '/tmp/workflow-marketplace/workflows/local-copy/workflow.json',
			});
		files['/tmp/workflow-marketplace/workflows/local-copy/workflow.json'] =
			JSON.stringify({
				name: 'local-copy',
				plugins: [],
				promptTemplate: 'live source',
				workflowFile: 'workflow.md',
			});
		files['/tmp/workflow-marketplace/workflows/local-copy/workflow.md'] =
			'# Live Workflow';

		const result = resolveWorkflow('local-copy');

		expect(result.promptTemplate).toBe('installed snapshot');
		expect(
			JSON.parse(
				files[
					'/home/testuser/.config/athena/workflows/local-copy/workflow.json'
				]!,
			).promptTemplate,
		).toBe('installed snapshot');
	});

	it('throws when workflow is not installed', () => {
		expect(() => resolveWorkflow('nonexistent')).toThrow(/not found/);
	});

	it('throws when workflow.json has invalid plugins field', () => {
		files['/home/testuser/.config/athena/workflows/bad/workflow.json'] =
			JSON.stringify({name: 'bad', plugins: 'not-an-array'});

		expect(() => resolveWorkflow('bad')).toThrow(/plugins.*must be an array/);
	});

	it('throws when plugin spec has empty ref or version', () => {
		files['/home/testuser/.config/athena/workflows/bad-spec/workflow.json'] =
			JSON.stringify({
				name: 'bad-spec',
				plugins: [{ref: '', version: '1.0.0'}],
				promptTemplate: '{input}',
			});
		expect(() => resolveWorkflow('bad-spec')).toThrow(
			/valid marketplace ref string or/,
		);

		files['/home/testuser/.config/athena/workflows/bad-spec/workflow.json'] =
			JSON.stringify({
				name: 'bad-spec',
				plugins: [{ref: 'foo@owner/repo', version: '  '}],
				promptTemplate: '{input}',
			});
		expect(() => resolveWorkflow('bad-spec')).toThrow(
			/valid marketplace ref string or/,
		);
	});

	it('throws when plugin spec is a non-string non-object', () => {
		files['/home/testuser/.config/athena/workflows/bad-type/workflow.json'] =
			JSON.stringify({
				name: 'bad-type',
				plugins: [42],
				promptTemplate: '{input}',
			});
		expect(() => resolveWorkflow('bad-type')).toThrow(
			/valid marketplace ref string or/,
		);
	});

	it('throws when plugin spec is a blank string', () => {
		files['/home/testuser/.config/athena/workflows/bad-string/workflow.json'] =
			JSON.stringify({
				name: 'bad-string',
				plugins: ['   '],
				promptTemplate: '{input}',
			});

		expect(() => resolveWorkflow('bad-string')).toThrow(
			/valid marketplace ref string or/,
		);
	});

	it('throws when plugin spec string is not a valid marketplace ref', () => {
		files['/home/testuser/.config/athena/workflows/bad-ref/workflow.json'] =
			JSON.stringify({
				name: 'bad-ref',
				plugins: ['not-a-valid-ref'],
				promptTemplate: '{input}',
			});

		expect(() => resolveWorkflow('bad-ref')).toThrow(
			/valid marketplace ref string or/,
		);
	});

	it('throws when workflow.json is missing promptTemplate', () => {
		files['/home/testuser/.config/athena/workflows/bad2/workflow.json'] =
			JSON.stringify({name: 'bad2', plugins: [], workflowFile: 'workflow.md'});
		files['/home/testuser/.config/athena/workflows/bad2/workflow.md'] =
			'# Workflow';

		expect(() => resolveWorkflow('bad2')).toThrow(
			/promptTemplate.*must be a string/,
		);
	});

	it('resolves relative workflowFile to an absolute path when file exists', () => {
		files['/home/testuser/.config/athena/workflows/sys/workflow.json'] =
			JSON.stringify({
				name: 'sys',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'prompt.md',
			});
		files['/home/testuser/.config/athena/workflows/sys/prompt.md'] = '# Prompt';

		const result = resolveWorkflow('sys');

		expect(result.workflowFile).toBe(
			'/home/testuser/.config/athena/workflows/sys/prompt.md',
		);
	});

	it('throws when workflow.json is missing required workflowFile', () => {
		files['/home/testuser/.config/athena/workflows/legacy/workflow.json'] =
			JSON.stringify({
				name: 'legacy',
				plugins: [],
				promptTemplate: '{input}',
			});

		expect(() => resolveWorkflow('legacy')).toThrow(/workflowFile.*required/);
	});

	it('throws when workflowFile does not exist', () => {
		files[
			'/home/testuser/.config/athena/workflows/missing-file/workflow.json'
		] = JSON.stringify({
			name: 'missing-file',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});

		expect(() => resolveWorkflow('missing-file')).toThrow(
			/workflowFile .*not found/,
		);
	});

	it('re-syncs workflow files from marketplace when source ref exists', () => {
		// Simulate a previously installed marketplace workflow
		const staleWorkflow = {
			name: 'mkt-workflow',
			plugins: ['plugin@owner/repo'],
			promptTemplate: '{input}',
			description: 'old description',
			workflowFile: 'workflow.md',
		};
		files[
			'/home/testuser/.config/athena/workflows/mkt-workflow/workflow.json'
		] = JSON.stringify(staleWorkflow);
		files['/home/testuser/.config/athena/workflows/mkt-workflow/source.json'] =
			JSON.stringify({kind: 'marketplace', ref: 'mkt-workflow@owner/repo'});

		// Simulate git pull having fetched a newer version in the marketplace cache
		const freshWorkflow = {
			name: 'mkt-workflow',
			plugins: ['plugin@owner/repo'],
			promptTemplate: '{input}',
			description: 'updated description',
			workflowFile: 'workflow.md',
		};
		files['/tmp/resolved-workflow.json'] = JSON.stringify(freshWorkflow);
		files['/tmp/workflow.md'] = '# Workflow';

		const result = resolveWorkflow('mkt-workflow');

		expect(result.description).toBe('updated description');
		// Installed copy should also be updated
		const installed = JSON.parse(
			files[
				'/home/testuser/.config/athena/workflows/mkt-workflow/workflow.json'
			]!,
		);
		expect(installed.description).toBe('updated description');
	});

	it('re-syncs workflow.md from workflowFile in marketplace source', () => {
		files['/home/testuser/.config/athena/workflows/synced/workflow.json'] =
			JSON.stringify({
				name: 'synced',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
			});
		files['/home/testuser/.config/athena/workflows/synced/workflow.md'] =
			'# Old Workflow';
		files['/home/testuser/.config/athena/workflows/synced/source.json'] =
			JSON.stringify({kind: 'marketplace', ref: 'synced@owner/repo'});

		// Marketplace has updated workflow and prompt
		files['/tmp/resolved-workflow.json'] = JSON.stringify({
			name: 'synced',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# New Workflow';

		const result = resolveWorkflow('synced');

		expect(result.workflowFile).toBe(
			'/home/testuser/.config/athena/workflows/synced/workflow.md',
		);
		expect(
			files['/home/testuser/.config/athena/workflows/synced/workflow.md'],
		).toBe('# New Workflow');
	});

	it('gracefully falls back to installed copy when marketplace sync fails', () => {
		const workflow = {
			name: 'offline-wf',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		};
		files['/home/testuser/.config/athena/workflows/offline-wf/workflow.json'] =
			JSON.stringify(workflow);
		files['/home/testuser/.config/athena/workflows/offline-wf/workflow.md'] =
			'# Workflow';
		// source.json references a marketplace, but resolveMarketplaceWorkflow
		// points to a file that doesn't exist (simulating failure)
		files['/home/testuser/.config/athena/workflows/offline-wf/source.json'] =
			JSON.stringify({kind: 'marketplace', ref: 'offline-wf@owner/repo'});
		// Do NOT create /tmp/resolved-workflow.json — simulates marketplace being unavailable

		const result = resolveWorkflow('offline-wf');

		expect(result.name).toBe('offline-wf');
	});

	it('allows extra legacy keys when required workflowFile is present', () => {
		files['/home/testuser/.config/athena/workflows/legacy/workflow.json'] =
			JSON.stringify({
				name: 'legacy',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {
					enabled: true,
					completionMarkers: ['DONE', 'BLOCKED'],
					trackerFile: 'legacy.md',
					maxIterations: 3,
				},
			});
		files['/home/testuser/.config/athena/workflows/legacy/workflow.md'] =
			'# Workflow';

		const result = resolveWorkflow('legacy');
		expect(result.workflowFile).toBe(
			'/home/testuser/.config/athena/workflows/legacy/workflow.md',
		);
	});

	it('throws when source metadata omits explicit kind', () => {
		files['/home/testuser/.config/athena/workflows/strict/workflow.json'] =
			JSON.stringify({
				name: 'strict',
				plugins: [],
				promptTemplate: 'installed snapshot',
				workflowFile: 'workflow.md',
			});
		files['/home/testuser/.config/athena/workflows/strict/workflow.md'] =
			'# Workflow';
		files['/home/testuser/.config/athena/workflows/strict/source.json'] =
			JSON.stringify({ref: 'strict@owner/repo'});
		files['/tmp/resolved-workflow.json'] = JSON.stringify({
			name: 'strict',
			plugins: [],
			promptTemplate: 'marketplace snapshot',
		});

		expect(() => resolveWorkflow('strict')).toThrow(/Invalid source\.json/);
	});
});

describe('installWorkflow', () => {
	it('installs a workflow from a local file using its name field', () => {
		const workflow = {
			name: 'my-workflow',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		};
		files['/tmp/workflow.json'] = JSON.stringify(workflow);
		files['/tmp/workflow.md'] = '# Workflow';

		const name = installWorkflow('/tmp/workflow.json');

		expect(name).toBe('my-workflow');
		expect(
			files[
				'/home/testuser/.config/athena/workflows/my-workflow/workflow.json'
			],
		).toBeDefined();
		expect(
			JSON.parse(
				files[
					'/home/testuser/.config/athena/workflows/my-workflow/source.json'
				]!,
			),
		).toEqual({
			v: 2,
			kind: 'filesystem',
			path: '/tmp/workflow.json',
		});
	});

	it('installs from marketplace ref', () => {
		files['/tmp/resolved-workflow.json'] = JSON.stringify({
			name: 'remote-workflow',
			plugins: ['plugin@owner/repo'],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';

		const name = installWorkflow('remote-workflow@owner/repo');
		expect(name).toBe('remote-workflow');
	});

	it('uses explicit name over workflow name field', () => {
		const workflow = {
			name: 'original',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		};
		files['/tmp/workflow.json'] = JSON.stringify(workflow);
		files['/tmp/workflow.md'] = '# Workflow';

		const name = installWorkflow('/tmp/workflow.json', 'custom-name');

		expect(name).toBe('custom-name');
	});

	it('persists marketplace source ref for later re-sync', () => {
		files['/tmp/resolved-workflow.json'] = JSON.stringify({
			name: 'mkt-workflow',
			plugins: ['plugin@owner/repo'],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';

		installWorkflow('mkt-workflow@owner/repo');

		const sourceFile =
			files['/home/testuser/.config/athena/workflows/mkt-workflow/source.json'];
		expect(sourceFile).toBeDefined();
		expect(JSON.parse(sourceFile!)).toEqual({
			v: 2,
			kind: 'marketplace-remote',
			ref: 'mkt-workflow@owner/repo',
		});
	});

	it('records local source metadata for local file installs', () => {
		files['/tmp/workflow.json'] = JSON.stringify({
			name: 'local-only',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';

		installWorkflow('/tmp/workflow.json');

		expect(
			JSON.parse(
				files[
					'/home/testuser/.config/athena/workflows/local-only/source.json'
				]!,
			),
		).toEqual({
			v: 2,
			kind: 'filesystem',
			path: '/tmp/workflow.json',
		});
	});

	it('copies workflow.md referenced by workflowFile next to installed workflow.json', () => {
		files['/tmp/workflow.json'] = JSON.stringify({
			name: 'asset-workflow',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';

		const name = installWorkflow('/tmp/workflow.json');

		expect(name).toBe('asset-workflow');
		expect(
			files[
				'/home/testuser/.config/athena/workflows/asset-workflow/workflow.md'
			],
		).toBe('# Workflow');
	});

	it('rejects workflow assets that escape the source workflow directory', () => {
		files['/tmp/workflow.json'] = JSON.stringify({
			name: 'unsafe-workflow',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: '../prompt.md',
		});
		files['/prompt.md'] = '# Prompt';

		expect(() => installWorkflow('/tmp/workflow.json')).toThrow(
			/outside the workflow root/,
		);
	});

	it('throws on install when workflowFile is missing', () => {
		files['/tmp/workflow.json'] = JSON.stringify({
			name: 'missing-workflow-file',
			plugins: [],
			promptTemplate: '{input}',
		});

		expect(() => installWorkflow('/tmp/workflow.json')).toThrow(
			/workflowFile.*required/,
		);
	});
});

describe('updateWorkflow', () => {
	it('re-installs a marketplace workflow from its recorded source', () => {
		files['/tmp/resolved-workflow.json'] = JSON.stringify({
			name: 'update-me',
			plugins: [{ref: 'pinned-plugin@owner/repo', version: '1.2.3'}],
			promptTemplate: 'new',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';
		files['/home/testuser/.config/athena/workflows/update-me/workflow.json'] =
			JSON.stringify({
				name: 'update-me',
				plugins: [],
				promptTemplate: 'old',
				workflowFile: 'workflow.md',
			});
		files['/home/testuser/.config/athena/workflows/update-me/workflow.md'] =
			'# Old Workflow';
		files['/home/testuser/.config/athena/workflows/update-me/source.json'] =
			JSON.stringify({
				kind: 'marketplace',
				ref: 'update-me@owner/repo',
			});

		const name = updateWorkflow('update-me');

		expect(name).toBe('update-me');
		expect(
			JSON.parse(
				files[
					'/home/testuser/.config/athena/workflows/update-me/workflow.json'
				]!,
			).promptTemplate,
		).toBe('new');
		expect(refreshPinnedWorkflowPluginsMock).toHaveBeenCalledWith({
			name: 'update-me',
			plugins: [{ref: 'pinned-plugin@owner/repo', version: '1.2.3'}],
			promptTemplate: 'new',
			workflowFile:
				'/home/testuser/.config/athena/workflows/update-me/workflow.md',
			__source: {
				kind: 'marketplace-remote',
				ref: 'update-me@owner/repo',
			},
		});
	});

	it('re-installs a local workflow from its recorded source path', () => {
		files['/tmp/workflow.json'] = JSON.stringify({
			name: 'local-update',
			plugins: [],
			promptTemplate: 'new',
			workflowFile: 'workflow.md',
		});
		files['/tmp/workflow.md'] = '# Workflow';
		files[
			'/home/testuser/.config/athena/workflows/local-update/workflow.json'
		] = JSON.stringify({
			name: 'local-update',
			plugins: [],
			promptTemplate: 'old',
			workflowFile: 'workflow.md',
		});
		files['/home/testuser/.config/athena/workflows/local-update/workflow.md'] =
			'# Old Workflow';
		files['/home/testuser/.config/athena/workflows/local-update/source.json'] =
			JSON.stringify({
				kind: 'local',
				path: '/tmp/workflow.json',
			});

		const name = updateWorkflow('local-update');

		expect(name).toBe('local-update');
		expect(
			JSON.parse(
				files[
					'/home/testuser/.config/athena/workflows/local-update/workflow.json'
				]!,
			).promptTemplate,
		).toBe('new');
	});

	it('throws when a workflow has no recorded source', () => {
		files['/home/testuser/.config/athena/workflows/no-source/workflow.json'] =
			JSON.stringify({
				name: 'no-source',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
			});
		files['/home/testuser/.config/athena/workflows/no-source/workflow.md'] =
			'# Workflow';

		expect(() => updateWorkflow('no-source')).toThrow(/has no recorded source/);
	});
});

describe('listWorkflows', () => {
	it('returns empty array when no workflows installed', () => {
		expect(listWorkflows()).toEqual([]);
	});

	it('lists installed workflow names', () => {
		dirs.add('/home/testuser/.config/athena/workflows');
		files['/home/testuser/.config/athena/workflows/e2e-testing/workflow.json'] =
			'{}';
		files['/home/testuser/.config/athena/workflows/code-review/workflow.json'] =
			'{}';
		dirs.add('/home/testuser/.config/athena/workflows/e2e-testing');
		dirs.add('/home/testuser/.config/athena/workflows/code-review');

		const result = listWorkflows();

		expect(result.sort()).toEqual(['code-review', 'e2e-testing']);
	});
});

describe('removeWorkflow', () => {
	it('removes an installed workflow', () => {
		files['/home/testuser/.config/athena/workflows/e2e-testing/workflow.json'] =
			'{}';
		dirs.add('/home/testuser/.config/athena/workflows/e2e-testing');

		removeWorkflow('e2e-testing');

		// rmSync was called (the mock deletes from files/dirs)
	});

	it('throws when workflow does not exist', () => {
		expect(() => removeWorkflow('nonexistent')).toThrow(/not found/);
	});
});

describe('installWorkflowFromSource', () => {
	it('persists marketplace-local identity in source.json v2', () => {
		files['/tmp/m/workflows/w/workflow.json'] = JSON.stringify({
			name: 'w',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/m/workflows/w/workflow.md'] = '# w';

		const name = installWorkflowFromSource({
			kind: 'marketplace-local',
			repoDir: '/tmp/m',
			workflowName: 'w',
			version: '1.0.0',
			manifestPath: '/tmp/m/.athena-workflow/marketplace.json',
			workflowPath: '/tmp/m/workflows/w/workflow.json',
		});
		expect(name).toBe('w');

		const stored = JSON.parse(
			files['/home/testuser/.config/athena/workflows/w/source.json']!,
		);
		expect(stored).toEqual({
			v: 2,
			kind: 'marketplace-local',
			repoDir: '/tmp/m',
			workflowName: 'w',
			version: '1.0.0',
		});
	});

	it('persists marketplace-remote identity with ref and version', () => {
		files['/tmp/cache/workflow.json'] = JSON.stringify({
			name: 'w',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/cache/workflow.md'] = '# w';

		installWorkflowFromSource({
			kind: 'marketplace-remote',
			slug: 'owner/repo',
			owner: 'owner',
			repo: 'repo',
			workflowName: 'w',
			version: '1.2.3',
			ref: 'w@owner/repo',
			manifestPath: '/tmp/cache/.athena-workflow/marketplace.json',
			workflowPath: '/tmp/cache/workflow.json',
		});

		const stored = JSON.parse(
			files['/home/testuser/.config/athena/workflows/w/source.json']!,
		);
		expect(stored).toEqual({
			v: 2,
			kind: 'marketplace-remote',
			ref: 'w@owner/repo',
			version: '1.2.3',
		});
	});

	it('persists filesystem identity for loose workflow.json installs', () => {
		files['/tmp/loose/workflow.json'] = JSON.stringify({
			name: 'loose-w',
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'workflow.md',
		});
		files['/tmp/loose/workflow.md'] = '# w';

		installWorkflowFromSource({
			kind: 'filesystem',
			workflowPath: '/tmp/loose/workflow.json',
		});
		const stored = JSON.parse(
			files['/home/testuser/.config/athena/workflows/loose-w/source.json']!,
		);
		expect(stored).toEqual({
			v: 2,
			kind: 'filesystem',
			path: '/tmp/loose/workflow.json',
		});
	});
});
