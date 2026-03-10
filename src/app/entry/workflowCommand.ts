import {
	installWorkflow,
	listWorkflows,
	removeWorkflow,
	updateWorkflow,
} from '../../core/workflows/index';
import {
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	pullMarketplaceRepo,
	resolveWorkflowInstallSource,
	resolveWorkflowMarketplaceSource,
} from '../../infra/plugins/marketplace';
import {readGlobalConfig, writeGlobalConfig} from '../../infra/plugins/config';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

const USAGE = `Usage: athena-flow workflow <subcommand>

Subcommands
  install <source>   Install a workflow from a name, file path, or marketplace ref
  list               List installed workflows
  remove <name>      Remove an installed workflow
  update [name]      Re-sync an installed workflow from its recorded source
  use-marketplace <source>
                     Set workflow marketplace source (owner/repo or local path)
  update-marketplace [source]
                     Refresh the current marketplace source (default: configured source or ${DEFAULT_MARKETPLACE_SLUG})
  use <name>         Set the globally active workflow`;

export type WorkflowCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
};

export type WorkflowCommandDeps = {
	installWorkflow?: typeof installWorkflow;
	listWorkflows?: typeof listWorkflows;
	removeWorkflow?: typeof removeWorkflow;
	updateWorkflow?: typeof updateWorkflow;
	pullMarketplaceRepo?: typeof pullMarketplaceRepo;
	listMarketplaceWorkflows?: typeof listMarketplaceWorkflows;
	listMarketplaceWorkflowsFromRepo?: typeof listMarketplaceWorkflowsFromRepo;
	resolveWorkflowInstallSource?: typeof resolveWorkflowInstallSource;
	resolveWorkflowMarketplaceSource?: typeof resolveWorkflowMarketplaceSource;
	readGlobalConfig?: typeof readGlobalConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

export function runWorkflowCommand(
	input: WorkflowCommandInput,
	deps: WorkflowCommandDeps = {},
): number {
	const install = deps.installWorkflow ?? installWorkflow;
	const list = deps.listWorkflows ?? listWorkflows;
	const remove = deps.removeWorkflow ?? removeWorkflow;
	const update = deps.updateWorkflow ?? updateWorkflow;
	const pullMarketplace = deps.pullMarketplaceRepo ?? pullMarketplaceRepo;
	const listMarketplace =
		deps.listMarketplaceWorkflows ?? listMarketplaceWorkflows;
	const listMarketplaceFromRepo =
		deps.listMarketplaceWorkflowsFromRepo ?? listMarketplaceWorkflowsFromRepo;
	const resolveInstallSource =
		deps.resolveWorkflowInstallSource ?? resolveWorkflowInstallSource;
	const resolveMarketplaceSource =
		deps.resolveWorkflowMarketplaceSource ?? resolveWorkflowMarketplaceSource;
	const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
	const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	switch (input.subcommand) {
		case 'install': {
			const source = input.subcommandArgs[0];
			if (!source) {
				logError('Usage: athena-flow workflow install <source>');
				return 1;
			}
			try {
				const installSource = resolveInstallSource(
					source,
					readConfig().workflowMarketplaceSource ?? DEFAULT_MARKETPLACE_SLUG,
				);
				const name = install(installSource);
				logOut(`Installed workflow: ${name}`);
				return 0;
			} catch (error) {
				logError(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return 1;
			}
		}

		case 'list': {
			const workflows = list();
			if (workflows.length === 0) {
				logOut('No workflows installed.');
			} else {
				for (const name of workflows) {
					logOut(name);
				}
			}
			return 0;
		}

		case 'update': {
			const configuredActiveWorkflow = readConfig().activeWorkflow;
			const name = input.subcommandArgs[0] ?? configuredActiveWorkflow;
			if (!name) {
				logError('Usage: athena-flow workflow update [name]');
				return 1;
			}
			try {
				const updatedName = update(name);
				logOut(`Updated workflow: ${updatedName}`);
				return 0;
			} catch (error) {
				logError(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return 1;
			}
		}

		case 'update-marketplace': {
			const source =
				input.subcommandArgs[0] ??
				readConfig().workflowMarketplaceSource ??
				DEFAULT_MARKETPLACE_SLUG;
			try {
				const resolvedSource = resolveMarketplaceSource(source);
				if (resolvedSource.kind === 'remote') {
					pullMarketplace(resolvedSource.owner, resolvedSource.repo);
					logOut(`Updated marketplace: ${resolvedSource.slug}`);
				} else {
					listMarketplaceFromRepo(resolvedSource.repoDir);
					logOut(`Local marketplace ready: ${resolvedSource.repoDir}`);
				}
				return 0;
			} catch (error) {
				logError(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return 1;
			}
		}

		case 'use-marketplace': {
			const source = input.subcommandArgs[0];
			if (!source) {
				logError('Usage: athena-flow workflow use-marketplace <source>');
				return 1;
			}
			try {
				const resolvedSource = resolveMarketplaceSource(source);
				if (resolvedSource.kind === 'remote') {
					listMarketplace(resolvedSource.owner, resolvedSource.repo);
					writeConfig({workflowMarketplaceSource: resolvedSource.slug});
					logOut(`Workflow marketplace: ${resolvedSource.slug}`);
				} else {
					listMarketplaceFromRepo(resolvedSource.repoDir);
					writeConfig({workflowMarketplaceSource: resolvedSource.repoDir});
					logOut(`Workflow marketplace: ${resolvedSource.repoDir}`);
				}
				return 0;
			} catch (error) {
				logError(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return 1;
			}
		}

		case 'remove': {
			const name = input.subcommandArgs[0];
			if (!name) {
				logError('Usage: athena-flow workflow remove <name>');
				return 1;
			}
			try {
				remove(name);
				if (readConfig().activeWorkflow === name) {
					writeConfig({activeWorkflow: undefined});
					logOut('Active workflow cleared.');
				}
				logOut(`Removed workflow: ${name}`);
				return 0;
			} catch (error) {
				logError(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return 1;
			}
		}

		case 'use': {
			const name = input.subcommandArgs[0];
			if (!name) {
				logError('Usage: athena-flow workflow use <name>');
				return 1;
			}

			const installed = list();
			if (!installed.includes(name)) {
				logError(`Error: Workflow "${name}" is not installed.`);
				return 1;
			}

			writeConfig({activeWorkflow: name});
			logOut(`Active workflow: ${name}`);
			return 0;
		}

		default:
			logError(USAGE);
			return 1;
	}
}
