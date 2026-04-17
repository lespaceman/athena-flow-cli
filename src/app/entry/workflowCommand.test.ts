import {describe, expect, it, vi} from 'vitest';
import {
	runWorkflowCommand,
	type WorkflowCommandDeps,
	type WorkflowCommandInput,
} from './workflowCommand';
import {
	WorkflowAmbiguityError,
	type ResolvedWorkflowSource,
} from '../../infra/plugins/marketplace';

const TEST_PROJECT_DIR = '/test/project';

const emptyConfig = {
	plugins: [],
	additionalDirectories: [],
};

function runCmd(
	input: Omit<WorkflowCommandInput, 'projectDir'>,
	deps: WorkflowCommandDeps = {},
): number {
	return runWorkflowCommand({...input, projectDir: TEST_PROJECT_DIR}, deps);
}

describe('runWorkflowCommand', () => {
	describe('install', () => {
		it('installs a workflow and prints the name', () => {
			const logOut = vi.fn();
			const resolvedSource: ResolvedWorkflowSource = {
				kind: 'filesystem',
				workflowPath: '/path/to/workflow.json',
			};
			const resolveWorkflowInstall = vi.fn().mockReturnValue(resolvedSource);
			const installWorkflowFromSource = vi.fn().mockReturnValue('my-workflow');
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'my-workflow',
				version: '1.0.0',
			});
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: ['/path/to/workflow.json'],
				},
				{
					resolveWorkflowInstall,
					installWorkflowFromSource,
					resolveWorkflow,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowInstall).toHaveBeenCalledWith(
				'/path/to/workflow.json',
				['lespaceman/athena-workflow-marketplace'],
			);
			expect(installWorkflowFromSource).toHaveBeenCalledWith(resolvedSource);
			expect(logOut).toHaveBeenCalledWith(
				'Installed workflow: my-workflow (1.0.0)',
			);
		});

		it('resolves bare workflow names from configured marketplace sources', () => {
			const logOut = vi.fn();
			const resolvedSource: ResolvedWorkflowSource = {
				kind: 'marketplace-local',
				repoDir: '/local/workflow-marketplace',
				workflowName: 'e2e-test-builder',
				manifestPath:
					'/local/workflow-marketplace/workflows/e2e-test-builder/workflow.json',
				workflowPath:
					'/local/workflow-marketplace/workflows/e2e-test-builder/workflow.json',
			};
			const resolveWorkflowInstall = vi.fn().mockReturnValue(resolvedSource);
			const installWorkflowFromSource = vi
				.fn()
				.mockReturnValue('e2e-test-builder');
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'e2e-test-builder',
				version: '2.4.1',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				workflowMarketplaceSources: ['/local/workflow-marketplace'],
			});

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: ['e2e-test-builder'],
				},
				{
					resolveWorkflowInstall,
					installWorkflowFromSource,
					resolveWorkflow,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowInstall).toHaveBeenCalledWith('e2e-test-builder', [
				'/local/workflow-marketplace',
			]);
			expect(installWorkflowFromSource).toHaveBeenCalledWith(resolvedSource);
			expect(logOut).toHaveBeenCalledWith(
				'Installed workflow: e2e-test-builder (2.4.1)',
			);
		});

		it('forwards version-pinned identifiers to the resolver', () => {
			const resolvedSource: ResolvedWorkflowSource = {
				kind: 'marketplace-remote',
				slug: 'lespaceman/athena-workflow-marketplace',
				owner: 'lespaceman',
				repo: 'athena-workflow-marketplace',
				workflowName: 'e2e-test-builder',
				version: '0.0.2',
				ref: 'e2e-test-builder@0.0.2',
				manifestPath: '/resolved/manifest.json',
				workflowPath: '/resolved/path',
			};
			const resolveWorkflowInstall = vi.fn().mockReturnValue(resolvedSource);
			const installWorkflowFromSource = vi
				.fn()
				.mockReturnValue('e2e-test-builder');
			const resolveWorkflow = vi
				.fn()
				.mockReturnValue({name: 'e2e-test-builder', version: '0.0.2'});
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: ['e2e-test-builder@0.0.2'],
				},
				{
					resolveWorkflowInstall,
					installWorkflowFromSource,
					resolveWorkflow,
					readGlobalConfig,
					logOut: vi.fn(),
				},
			);

			expect(code).toBe(0);
			expect(resolveWorkflowInstall).toHaveBeenCalledWith(
				'e2e-test-builder@0.0.2',
				['lespaceman/athena-workflow-marketplace'],
			);
		});

		it('prints error when install fails', () => {
			const logError = vi.fn();
			const resolveWorkflowInstall = vi.fn().mockImplementation(() => {
				throw new Error('file not found');
			});
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: ['/bad/path'],
				},
				{
					resolveWorkflowInstall,
					readGlobalConfig,
					logError,
				},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith('Error: file not found');
		});

		it('prints usage when source is missing', () => {
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: [],
				},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow workflow install <source>',
			);
		});
	});

	describe('search', () => {
		it('lists workflows from the default marketplace and shows their source', () => {
			const logOut = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([
				{
					name: 'e2e-test-builder',
					version: '1.2.3',
					description: 'Build Playwright coverage',
					workflowPath: '/cache/e2e-test-builder/workflow.json',
					ref: 'e2e-test-builder@lespaceman/athena-workflow-marketplace',
					source: {
						kind: 'remote',
						slug: 'lespaceman/athena-workflow-marketplace',
						owner: 'lespaceman',
						repo: 'athena-workflow-marketplace',
					},
				},
			]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'lespaceman/athena-workflow-marketplace',
				owner: 'lespaceman',
				repo: 'athena-workflow-marketplace',
			});
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'search',
					subcommandArgs: [],
				},
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
				'e2e-test-builder (1.2.3) - Build Playwright coverage [from lespaceman/athena-workflow-marketplace]',
			);
		});

		it('disambiguates duplicate names across remote and local sources', () => {
			const logOut = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([
				{
					name: 'e2e-test-builder',
					version: '0.0.1',
					workflowPath: '/cache/remote/workflow.json',
					ref: 'e2e-test-builder@owner/repo',
					source: {
						kind: 'remote',
						slug: 'owner/repo',
						owner: 'owner',
						repo: 'repo',
					},
				},
			]);
			const listMarketplaceWorkflowsFromRepo = vi.fn().mockReturnValue([
				{
					name: 'e2e-test-builder',
					version: '0.0.2',
					workflowPath: '/local/path/workflows/e2e-test-builder/workflow.json',
					ref: undefined,
					source: {kind: 'local', repoDir: '/local/path'},
				},
			]);
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
				...emptyConfig,
				workflowMarketplaceSources: ['owner/repo', '/local/path'],
			});

			const code = runCmd(
				{
					subcommand: 'search',
					subcommandArgs: [],
				},
				{
					listMarketplaceWorkflows,
					listMarketplaceWorkflowsFromRepo,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith(
				'e2e-test-builder (0.0.1) [from owner/repo]',
			);
			expect(logOut).toHaveBeenCalledWith(
				'e2e-test-builder (0.0.2) [from local:/local/path]',
			);
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
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'search',
					subcommandArgs: [],
				},
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

			const code = runCmd(
				{
					subcommand: 'upgrade',
					subcommandArgs: ['alpha'],
				},
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

			const code = runCmd(
				{
					subcommand: 'upgrade',
					subcommandArgs: [],
				},
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

			const code = runCmd(
				{
					subcommand: 'upgrade',
					subcommandArgs: [],
				},
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

			const code = runCmd(
				{
					subcommand: 'upgrade',
					subcommandArgs: [],
				},
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

			const code = runCmd(
				{
					subcommand: 'list',
					subcommandArgs: [],
				},
				{listWorkflows, resolveWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('alpha (1.0.0)');
			expect(logOut).toHaveBeenCalledWith('beta');
		});

		it('prints message when no workflows installed', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue([]);

			const code = runCmd(
				{
					subcommand: 'list',
					subcommandArgs: [],
				},
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
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'remove',
					subcommandArgs: ['my-workflow'],
				},
				{removeWorkflow, readGlobalConfig, readProjectConfig, logOut},
			);

			expect(code).toBe(0);
			expect(removeWorkflow).toHaveBeenCalledWith('my-workflow');
			expect(logOut).toHaveBeenCalledWith('Removed workflow: my-workflow');
		});

		it('clears global active workflow when removing the selected workflow', () => {
			const logOut = vi.fn();
			const removeWorkflow = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'my-workflow',
			});
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'remove',
					subcommandArgs: ['my-workflow'],
				},
				{
					removeWorkflow,
					readGlobalConfig,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				activeWorkflow: undefined,
			});
			expect(writeProjectConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith('Active workflow cleared.');
			expect(logOut).toHaveBeenCalledWith('Removed workflow: my-workflow');
		});

		it('clears project active workflow when removing the project-pinned workflow', () => {
			const logOut = vi.fn();
			const removeWorkflow = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const readProjectConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'project-pinned',
			});
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'remove',
					subcommandArgs: ['project-pinned'],
				},
				{
					removeWorkflow,
					readGlobalConfig,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeProjectConfig).toHaveBeenCalledWith(TEST_PROJECT_DIR, {
				activeWorkflow: undefined,
			});
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith('Project active workflow cleared.');
		});

		it('prints error when workflow not found', () => {
			const logError = vi.fn();
			const removeWorkflow = vi.fn().mockImplementation(() => {
				throw new Error('Workflow "ghost" not found.');
			});

			const code = runCmd(
				{
					subcommand: 'remove',
					subcommandArgs: ['ghost'],
				},
				{removeWorkflow, logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Error: Workflow "ghost" not found.',
			);
		});

		it('prints usage when name is missing', () => {
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'remove',
					subcommandArgs: [],
				},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow workflow remove <name>',
			);
		});
	});

	describe('use', () => {
		it('writes to global when no project pin exists', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha', 'beta']);
			const resolveWorkflow = vi.fn().mockReturnValue({
				name: 'beta',
				version: '2.1.0',
			});
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['beta'],
				},
				{
					listWorkflows,
					resolveWorkflow,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({activeWorkflow: 'beta'});
			expect(writeProjectConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith(
				'Active workflow: beta (2.1.0) [global]',
			);
		});

		it('still writes to global by default when a project pin exists', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['beta']);
			const resolveWorkflow = vi.fn().mockImplementation((name: string) => ({
				name,
			}));
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'alpha',
			});
			const readProjectConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'gamma',
			});
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['beta'],
				},
				{
					listWorkflows,
					resolveWorkflow,
					readGlobalConfig,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({activeWorkflow: 'beta'});
			expect(writeProjectConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith('Active workflow: beta [global]');
			expect(logOut).toHaveBeenCalledWith(
				`Effective workflow remains gamma [project: ${TEST_PROJECT_DIR}/.athena/config.json] because the project config overrides global.`,
			);
			expect(logOut).toHaveBeenCalledWith(
				`Use --project to update ${TEST_PROJECT_DIR}/.athena/config.json.`,
			);
		});

		it('respects --project flag even when no project pin exists yet', () => {
			const listWorkflows = vi.fn().mockReturnValue(['beta']);
			const resolveWorkflow = vi.fn().mockReturnValue({name: 'beta'});
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['--project', 'beta'],
				},
				{
					listWorkflows,
					resolveWorkflow,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut: vi.fn(),
				},
			);

			expect(code).toBe(0);
			expect(writeProjectConfig).toHaveBeenCalledWith(TEST_PROJECT_DIR, {
				activeWorkflow: 'beta',
			});
			expect(writeGlobalConfig).not.toHaveBeenCalled();
		});

		it('explains shadowing when --global is used while a project pin exists', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['beta']);
			const resolveWorkflow = vi.fn().mockImplementation((name: string) => ({
				name,
			}));
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'alpha',
			});
			const readProjectConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'gamma',
			});
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['--global', 'beta'],
				},
				{
					listWorkflows,
					resolveWorkflow,
					readGlobalConfig,
					readProjectConfig,
					writeGlobalConfig,
					writeProjectConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({activeWorkflow: 'beta'});
			expect(writeProjectConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith(
				`Effective workflow remains gamma [project: ${TEST_PROJECT_DIR}/.athena/config.json] because the project config overrides global.`,
			);
		});

		it('errors on conflicting --project and --global flags', () => {
			const logError = vi.fn();
			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['--project', '--global', 'beta'],
				},
				{logError},
			);
			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('mutually exclusive'),
			);
		});

		it('prints usage when name is missing', () => {
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: [],
				},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: athena-flow workflow use'),
			);
		});

		it('prints error when workflow is not installed', () => {
			const logError = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha']);
			const writeGlobalConfig = vi.fn();
			const writeProjectConfig = vi.fn();

			const code = runCmd(
				{
					subcommand: 'use',
					subcommandArgs: ['beta'],
				},
				{
					listWorkflows,
					writeGlobalConfig,
					writeProjectConfig,
					logError,
				},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(writeProjectConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith(
				'Error: Workflow "beta" is not installed.',
			);
		});
	});

	describe('status', () => {
		it('reports project pin as the effective layer when both layers are set', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'alpha',
			});
			const readProjectConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				activeWorkflow: 'beta',
			});
			const resolveWorkflow = vi
				.fn()
				.mockReturnValue({name: 'beta', version: '0.0.2'});

			const code = runCmd(
				{
					subcommand: 'status',
					subcommandArgs: [],
				},
				{readGlobalConfig, readProjectConfig, resolveWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith(
				'Active workflow: beta (0.0.2) [project]',
			);
			expect(logOut).toHaveBeenCalledWith('  global:  alpha');
			expect(logOut).toHaveBeenCalledWith('  project: beta');
			expect(logOut).toHaveBeenCalledWith(
				`  note: project config overrides global at ${TEST_PROJECT_DIR}/.athena/config.json`,
			);
		});

		it('reports default layer when neither config sets a workflow', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const resolveWorkflow = vi.fn().mockImplementation(() => {
				throw new Error('not installed');
			});

			const code = runCmd(
				{
					subcommand: 'status',
					subcommandArgs: [],
				},
				{readGlobalConfig, readProjectConfig, resolveWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('Active workflow: default [default]');
			expect(logOut).toHaveBeenCalledWith('  global:  (unset)');
			expect(logOut).toHaveBeenCalledWith('  project: (unset)');
		});
	});

	describe('unknown subcommand', () => {
		it('prints usage and returns 1', () => {
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'bogus',
					subcommandArgs: [],
				},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: athena-flow workflow'),
			);
		});
	});
});

describe('workflow install (ambiguity)', () => {
	it('prints all candidates when the same name is in two marketplaces', () => {
		const errLines: string[] = [];
		const outLines: string[] = [];
		const ambiguity = new WorkflowAmbiguityError('dup', [
			{sourceLabel: 'marketplace owner/a', disambiguator: 'dup@owner/a'},
			{
				sourceLabel: 'local marketplace /tmp/b',
				disambiguator: '/tmp/b/workflows/dup/workflow.json',
			},
		]);
		const code = runWorkflowCommand(
			{subcommand: 'install', subcommandArgs: ['dup'], projectDir: '/tmp/proj'},
			{
				readGlobalConfig: () =>
					({
						...emptyConfig,
						workflowMarketplaceSources: ['owner/a', '/tmp/b'],
					}) as ReturnType<
						typeof import('../../infra/plugins/config').readGlobalConfig
					>,
				resolveWorkflowInstall: () => {
					throw ambiguity;
				},
				installWorkflowFromSource: () => 'dup',
				logError: m => errLines.push(m),
				logOut: m => outLines.push(m),
			},
		);
		expect(code).toBe(1);
		expect(errLines.join('\n')).toContain('dup@owner/a');
		expect(errLines.join('\n')).toContain('/tmp/b');
	});
});
