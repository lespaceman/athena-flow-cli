import {describe, expect, it, vi} from 'vitest';
import {runWorkflowCommand} from './workflowCommand';

describe('runWorkflowCommand', () => {
	describe('install', () => {
		it('installs a workflow and prints the name', () => {
			const logOut = vi.fn();
			const installWorkflow = vi.fn().mockReturnValue('my-workflow');

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: ['/path/to/workflow.json']},
				{installWorkflow, logOut},
			);

			expect(code).toBe(0);
			expect(installWorkflow).toHaveBeenCalledWith('/path/to/workflow.json');
			expect(logOut).toHaveBeenCalledWith('Installed workflow: my-workflow');
		});

		it('prints error when install fails', () => {
			const logError = vi.fn();
			const installWorkflow = vi.fn().mockImplementation(() => {
				throw new Error('file not found');
			});

			const code = runWorkflowCommand(
				{subcommand: 'install', subcommandArgs: ['/bad/path']},
				{installWorkflow, logError},
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

	describe('list', () => {
		it('prints workflow names', () => {
			const logOut = vi.fn();
			const listWorkflows = vi.fn().mockReturnValue(['alpha', 'beta']);

			const code = runWorkflowCommand(
				{subcommand: 'list', subcommandArgs: []},
				{listWorkflows, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('alpha');
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
			const writeGlobalConfig = vi.fn();

			const code = runWorkflowCommand(
				{subcommand: 'use', subcommandArgs: ['beta']},
				{
					listWorkflows,
					writeGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({activeWorkflow: 'beta'});
			expect(logOut).toHaveBeenCalledWith('Active workflow: beta');
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
