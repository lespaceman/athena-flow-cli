import {describe, expect, it, vi} from 'vitest';
import {runWorkflowCommand} from './workflowCommand';

describe('runWorkflowCommand', () => {
	describe('install', () => {
		it('installs a workflow and prints the name', () => {
			const logOut = vi.fn();
			const installWorkflow = vi.fn().mockReturnValue('my-workflow');
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'my-workflow',
				version: '1.0.0',
			});
			const resolveWorkflowInstallSourceFromSources = vi
				.fn()
				.mockReturnValue('/path/to/workflow.json');
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: ['/path/to/workflow.json']},
				{
					installWorkflow,
					resolveWorkflow,
					resolveWorkflowInstallSourceFromSources,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowInstallSourceFromSources).toHaveBeenCalledWith(
				'/path/to/workflow.json',
				['lespaceman/athena-workflow-marketplace'],
			);
			expect(installWorkflow).toHaveBeenCalledWith('/path/to/workflow.json');
			expect(resolveWorkflow).toHaveBeenCalledWith('my-workflow');
			expect(logOut).toHaveBeenCalledWith(
				'Installed workflow: my-workflow (1.0.0)',
			);
		});

		it('resolves bare workflow names from configured marketplace sources', () => {
			const logOut = vi.fn();
			const installWorkflow = vi.fn().mockReturnValue('e2e-test-builder');
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'e2e-test-builder',
				version: '2.4.1',
			});
			const resolveWorkflowInstallSourceFromSources = vi
				.fn()
				.mockReturnValue(
					'/local/workflow-marketplace/workflows/e2e-test-builder/workflow.json',
				);
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['/local/workflow-marketplace'],
			});

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: ['e2e-test-builder']},
				{
					installWorkflow,
					resolveWorkflow,
					resolveWorkflowInstallSourceFromSources,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowInstallSourceFromSources).toHaveBeenCalledWith(
				'e2e-test-builder',
				['/local/workflow-marketplace'],
			);
			expect(installWorkflow).toHaveBeenCalledWith(
				'/local/workflow-marketplace/workflows/e2e-test-builder/workflow.json',
			);
			expect(logOut).toHaveBeenCalledWith(
				'Installed workflow: e2e-test-builder (2.4.1)',
			);
		});

		it('prints error when install fails', () => {
			const logError = vi.fn();
			const installWorkflow = vi.fn().mockImplementation(() => {
				throw new Error('file not found');
			});
			const resolveWorkflowInstallSourceFromSources = vi
				.fn()
				.mockReturnValue('/bad/path');
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: ['/bad/path']},
				{
					installWorkflow,
					resolveWorkflowInstallSourceFromSources,
					readGlobalConfig,
					logError,
				},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith('Error: file not found');
		});

		it('prints usage when source is missing', () => {
			const logError = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow workflow install <source>',
			);
		});
	});

	describe('search', () => {
		it('lists workflows from the default marketplace when no sources configured', () => {
			const logOut = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([
				{
					name: 'e2e-test-builder',
					version: '1.2.3',
					description: 'Build Playwright coverage',
				},
			]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'lespaceman/athena-workflow-marketplace',
				owner: 'lespaceman',
				repo: 'athena-workflow-marketplace',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runWorkflowCommand(
				{subcommand: 'search', subcommandArgs: []},
				{
					listMarketplaceWorkflows,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowMarketplaceSource).toHaveBeenCalledWith(
				'lespaceman/athena-workflow-marketplace',
			);
			expect(logOut).toHaveBeenCalledWith(
				'e2e-test-builder (1.2.3) - Build Playwright coverage',
			);
		});

		it('aggregates workflows from multiple configured sources', () => {
			const logOut = vi.fn();
			const listMarketplaceWorkflows = vi
				.fn()
				.mockReturnValue([{name: 'remote-flow'}]);
			const listMarketplaceWorkflowsFromRepo = vi
				.fn()
				.mockReturnValue([{name: 'local-flow'}]);
			const resolveWorkflowMarketplaceSource = vi
				.fn()
				.mockImplementation((source: string) => {
					if (source === 'owner/repo') {
						return {
							kind: 'remote',
							slug: 'owner/repo',
							owner: 'owner',
							repo: 'repo',
						};
					}
					return {kind: 'local', repoDir: '/local/path'};
				});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/repo', '/local/path'],
			});

			const code = runWorkflowCommand(
				{subcommand: 'search', subcommandArgs: []},
				{
					listMarketplaceWorkflows,
					listMarketplaceWorkflowsFromRepo,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('remote-flow');
			expect(logOut).toHaveBeenCalledWith('local-flow');
		});

		it('prints message when no workflows found', () => {
			const logOut = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'lespaceman/athena-workflow-marketplace',
				owner: 'lespaceman',
				repo: 'athena-workflow-marketplace',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runWorkflowCommand(
				{subcommand: 'search', subcommandArgs: []},
				{
					listMarketplaceWorkflows,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith(
				'No workflows found in any configured marketplace.',
			);
		});
	});

	describe('upgrade', () => {
		it('upgrades a workflow by name', () => {
			const logOut = vi.fn();
			const updateWorkflow = vi.fn().mockReturnValue('alpha');
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'alpha',
				version: '0.9.0',
			});

			const code = runWorkflowCommand(
				{subcommand: 'upgrade', subcommandArgs: ['alpha']},
				{updateWorkflow, resolveWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(updateWorkflow).toHaveBeenCalledWith('alpha');
			expect(logOut).toHaveBeenCalledWith('Upgraded workflow: alpha (0.9.0)');
		});

		it('upgrades all non-builtin workflows when no name given', () => {
			const logOut = vi.fn();
			const listWorkflows = vi
				.fn()
				.mockReturnValue(['default', 'alpha', 'beta']);
			const listBuiltinWorkflows = vi.fn().mockReturnValue(['default']);
			const updateWorkflow = vi.fn().mockImplementation((name: string) => name);
			const resolveWorkflow = vi
				.fn()
				.mockImplementation((name: string) => ({name}));

			const code = runWorkflowCommand(
				{subcommand: 'upgrade', subcommandArgs: []},
				{
					listWorkflows,
					listBuiltinWorkflows,
					updateWorkflow,
					resolveWorkflow,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(updateWorkflow).toHaveBeenCalledWith('alpha');
			expect(updateWorkflow).toHaveBeenCalledWith('beta');
			expect(updateWorkflow).not.toHaveBeenCalledWith('default');
		});

		it('prints message when no installed workflows to upgrade', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['default']);
			const listBuiltinWorkflows = vi.fn().mockReturnValue(['default']);

			const code = runWorkflowCommand(
				{subcommand: 'upgrade', subcommandArgs: []},
				{listWorkflows, listBuiltinWorkflows, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('No installed workflows to upgrade.');
		});

		it('returns 1 when any upgrade fails', () => {
			const logOut = vi.fn();
			const logError = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha', 'beta']);
			const listBuiltinWorkflows = vi.fn().mockReturnValue([]);
			const updateWorkflow = vi.fn().mockImplementation((name: string) => {
				if (name === 'beta') {
					throw new Error('no source');
				}
				return name;
			});
			const resolveWorkflow = vi
				.fn()
				.mockImplementation((name: string) => ({name}));

			const code = runWorkflowCommand(
				{subcommand: 'upgrade', subcommandArgs: []},
				{
					listWorkflows,
					listBuiltinWorkflows,
					updateWorkflow,
					resolveWorkflow,
					logOut,
					logError,
				},
			);

			expect(code).toBe(1);
			expect(logOut).toHaveBeenCalledWith('Upgraded workflow: alpha');
			expect(logError).toHaveBeenCalledWith(
				'Failed to upgrade "beta": Error: no source',
			);
		});
	});

	describe('list', () => {
		it('prints workflow names with versions when available', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha', 'beta']);
			const resolveWorkflow = vi.fn().mockImplementation((name: string) => {
				if (name === 'alpha') {
					return {name: 'alpha', version: '1.0.0'};
				}
				return {name: 'beta'};
			});

			const code = runWorkflowCommand(
				{subcommand: 'list', subcommandArgs: []},
				{listWorkflows, resolveWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('alpha (1.0.0)');
			expect(logOut).toHaveBeenCalledWith('beta');
		});

		it('prints message when no workflows installed', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue([]);

			const code = runWorkflowCommand(
				{subcommand: 'list', subcommandArgs: []},
				{listWorkflows, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('No workflows installed.');
		});
	});

	describe('remove', () => {
		it('removes a workflow and prints confirmation', () => {
			const logOut = vi.fn();
			const removeWorkflow = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runWorkflowCommand(
				{subcommand: 'remove', subcommandArgs: ['my-workflow']},
				{removeWorkflow, readGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(removeWorkflow).toHaveBeenCalledWith('my-workflow');
			expect(logOut).toHaveBeenCalledWith('Removed workflow: my-workflow');
		});

		it('clears active workflow when removing the selected workflow', () => {
			const logOut = vi.fn();
			const removeWorkflow = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				activeWorkflow: 'my-workflow',
			});
			const writeGlobalConfig = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'remove', subcommandArgs: ['my-workflow']},
				{
					removeWorkflow,
					readGlobalConfig,
					writeGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				activeWorkflow: undefined,
			});
			expect(logOut).toHaveBeenCalledWith('Active workflow cleared.');
			expect(logOut).toHaveBeenCalledWith('Removed workflow: my-workflow');
		});

		it('prints error when workflow not found', () => {
			const logError = vi.fn();
			const removeWorkflow = vi.fn().mockImplementation(() => {
				throw new Error('Workflow "ghost" not found.');
			});

			const code = runWorkflowCommand(
				{subcommand: 'remove', subcommandArgs: ['ghost']},
				{removeWorkflow, logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Error: Workflow "ghost" not found.',
			);
		});

		it('prints usage when name is missing', () => {
			const logError = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'remove', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow workflow remove <name>',
			);
		});
	});

	describe('use', () => {
		it('sets active workflow when workflow exists', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha', 'beta']);
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'beta',
				version: '2.1.0',
			});
			const writeGlobalConfig = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'use', subcommandArgs: ['beta']},
				{
					listWorkflows,
					resolveWorkflow,
					writeGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({activeWorkflow: 'beta'});
			expect(logOut).toHaveBeenCalledWith('Active workflow: beta (2.1.0)');
		});

		it('prints usage when name is missing', () => {
			const logError = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'use', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow workflow use <name>',
			);
		});

		it('prints error when workflow is not installed', () => {
			const logError = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha']);
			const writeGlobalConfig = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'use', subcommandArgs: ['beta']},
				{
					listWorkflows,
					writeGlobalConfig,
					logError,
				},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith(
				'Error: Workflow "beta" is not installed.',
			);
		});
	});

	describe('unknown subcommand', () => {
		it('prints usage and returns 1', () => {
			const logError = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'bogus', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: athena-flow workflow'),
			);
		});
	});
});
