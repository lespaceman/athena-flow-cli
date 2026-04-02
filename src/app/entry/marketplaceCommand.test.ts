import {describe, expect, it, vi} from 'vitest';
import {runMarketplaceCommand} from './marketplaceCommand';

describe('runMarketplaceCommand', () => {
	describe('add', () => {
		it('adds a remote marketplace source', () => {
			const logOut = vi.fn();
			const writeGlobalConfig = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'owner/repo',
				owner: 'owner',
				repo: 'repo',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: ['owner/repo']},
				{
					writeGlobalConfig,
					listMarketplaceWorkflows,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				workflowMarketplaceSources: ['owner/repo'],
			});
			expect(logOut).toHaveBeenCalledWith('Added marketplace: owner/repo');
		});

		it('adds a local marketplace source', () => {
			const logOut = vi.fn();
			const writeGlobalConfig = vi.fn();
			const listMarketplaceWorkflowsFromRepo = vi.fn().mockReturnValue([]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'local',
				repoDir: '/local/path',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: ['/local/path']},
				{
					writeGlobalConfig,
					listMarketplaceWorkflowsFromRepo,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				workflowMarketplaceSources: ['/local/path'],
			});
			expect(logOut).toHaveBeenCalledWith('Added marketplace: /local/path');
		});

		it('appends to existing sources', () => {
			const logOut = vi.fn();
			const writeGlobalConfig = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'owner/second',
				owner: 'owner',
				repo: 'second',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/first'],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: ['owner/second']},
				{
					writeGlobalConfig,
					listMarketplaceWorkflows,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				workflowMarketplaceSources: ['owner/first', 'owner/second'],
			});
		});

		it('deduplicates existing sources', () => {
			const logOut = vi.fn();
			const writeGlobalConfig = vi.fn();
			const listMarketplaceWorkflows = vi.fn().mockReturnValue([]);
			const resolveWorkflowMarketplaceSource = vi.fn().mockReturnValue({
				kind: 'remote',
				slug: 'owner/repo',
				owner: 'owner',
				repo: 'repo',
			});
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/repo'],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: ['owner/repo']},
				{
					writeGlobalConfig,
					listMarketplaceWorkflows,
					resolveWorkflowMarketplaceSource,
					readGlobalConfig,
					logOut,
				},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logOut).toHaveBeenCalledWith(
				'Marketplace already configured: owner/repo',
			);
		});

		it('prints usage when source is missing', () => {
			const logError = vi.fn();

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow marketplace add <source>',
			);
		});

		it('prints error when source validation fails', () => {
			const logError = vi.fn();
			const resolveWorkflowMarketplaceSource = vi
				.fn()
				.mockImplementation(() => {
					throw new Error('Invalid source');
				});

			const code = runMarketplaceCommand(
				{subcommand: 'add', subcommandArgs: ['bad']},
				{resolveWorkflowMarketplaceSource, logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith('Error: Invalid source');
		});
	});

	describe('remove', () => {
		it('removes a configured source', () => {
			const logOut = vi.fn();
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/repo', '/local/path'],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'remove', subcommandArgs: ['/local/path']},
				{writeGlobalConfig, readGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				workflowMarketplaceSources: ['owner/repo'],
			});
			expect(logOut).toHaveBeenCalledWith('Removed marketplace: /local/path');
		});

		it('prints error when source not found', () => {
			const logError = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/repo'],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'remove', subcommandArgs: ['nonexistent']},
				{readGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Marketplace not found: nonexistent',
			);
		});

		it('prints usage when source is missing', () => {
			const logError = vi.fn();

			const code = runMarketplaceCommand(
				{subcommand: 'remove', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				'Usage: athena-flow marketplace remove <source>',
			);
		});
	});

	describe('list', () => {
		it('lists configured sources', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['owner/repo', '/local/path'],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'list', subcommandArgs: []},
				{readGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith('owner/repo');
			expect(logOut).toHaveBeenCalledWith('/local/path');
		});

		it('prints default hint when no sources configured', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				plugins: [],
				additionalDirectories: [],
			});

			const code = runMarketplaceCommand(
				{subcommand: 'list', subcommandArgs: []},
				{readGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(logOut).toHaveBeenCalledWith(
				expect.stringContaining('No marketplace sources configured'),
			);
		});
	});

	describe('unknown subcommand', () => {
		it('prints usage and returns 1', () => {
			const logError = vi.fn();

			const code = runMarketplaceCommand(
				{subcommand: 'bogus', subcommandArgs: []},
				{logError},
			);

			expect(code).toBe(1);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: athena-flow marketplace'),
			);
		});
	});
});
