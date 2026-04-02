import {
	installWorkflow,
	listBuiltinWorkflows,
	listWorkflows,
	removeWorkflow,
	resolveWorkflow,
	updateWorkflow,
} from '../../core/workflows/index';
import {
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveWorkflowInstallSourceFromSources,
	resolveWorkflowMarketplaceSource,
} from '../../infra/plugins/marketplace';
import {readGlobalConfig, writeGlobalConfig} from '../../infra/plugins/config';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

const USAGE = `Usage: athena-flow workflow <subcommand>

Subcommands
  install <source>   Install a workflow from a name, file path, or marketplace ref
  list               List installed workflows
  search             Browse available workflows across all configured marketplaces
  remove <name>      Remove an installed workflow
  upgrade [name]     Re-sync installed workflow(s) from their recorded source
  use <name>         Set the globally active workflow`;

export type WorkflowCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
};

export type WorkflowCommandDeps = {
	installWorkflow?: typeof installWorkflow;
	listWorkflows?: typeof listWorkflows;
	listBuiltinWorkflows?: typeof listBuiltinWorkflows;
	removeWorkflow?: typeof removeWorkflow;
	updateWorkflow?: typeof updateWorkflow;
	resolveWorkflow?: typeof resolveWorkflow;
	listMarketplaceWorkflows?: typeof listMarketplaceWorkflows;
	listMarketplaceWorkflowsFromRepo?: typeof listMarketplaceWorkflowsFromRepo;
	resolveWorkflowInstallSourceFromSources?: typeof resolveWorkflowInstallSourceFromSources;
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
	const listBuiltins = deps.listBuiltinWorkflows ?? listBuiltinWorkflows;
	const remove = deps.removeWorkflow ?? removeWorkflow;
	const resolveInstalledWorkflow = deps.resolveWorkflow ?? resolveWorkflow;
	const upgrade = deps.updateWorkflow ?? updateWorkflow;
	const listMarketplace =
		deps.listMarketplaceWorkflows ?? listMarketplaceWorkflows;
	const listMarketplaceFromRepo =
		deps.listMarketplaceWorkflowsFromRepo ?? listMarketplaceWorkflowsFromRepo;
	const resolveInstallFromSources =
		deps.resolveWorkflowInstallSourceFromSources ??
		resolveWorkflowInstallSourceFromSources;
	const resolveMarketplaceSource =
		deps.resolveWorkflowMarketplaceSource ?? resolveWorkflowMarketplaceSource;
	const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
	const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	const fmtError = (error: unknown): string =>
		`Error: ${error instanceof Error ? error.message : String(error)}`;

	const formatMarketplaceWorkflow = (entry: {
		name: string;
		version?: string;
		description?: string;
	}): string => {
		const version = entry.version ? ` (${entry.version})` : '';
		const description = entry.description ? ` - ${entry.description}` : '';
		return `${entry.name}${version}${description}`;
	};

	const formatWorkflowLabel = (name: string): string => {
		try {
			const workflow = resolveInstalledWorkflow(name);
			return workflow.version
				? `${workflow.name} (${workflow.version})`
				: workflow.name;
		} catch {
			return name;
		}
	};

	const getMarketplaceSources = (): string[] => {
		const sources = readConfig().workflowMarketplaceSources;
		return sources && sources.length > 0 ? sources : [DEFAULT_MARKETPLACE_SLUG];
	};

	switch (input.subcommand) {
		case 'install': {
			const source = input.subcommandArgs[0];
			if (!source) {
				logError('Usage: athena-flow workflow install <source>');
				return 1;
			}
			try {
				const installSource = resolveInstallFromSources(
					source,
					getMarketplaceSources(),
				);
				const name = install(installSource);
				logOut(`Installed workflow: ${formatWorkflowLabel(name)}`);
				return 0;
			} catch (error) {
				logError(fmtError(error));
				return 1;
			}
		}

		case 'list': {
			const workflows = list();
			if (workflows.length === 0) {
				logOut('No workflows installed.');
			} else {
				for (const name of workflows) {
					logOut(formatWorkflowLabel(name));
				}
			}
			return 0;
		}

		case 'search': {
			const sources = getMarketplaceSources();
			try {
				let found = false;
				for (const source of sources) {
					const resolvedSource = resolveMarketplaceSource(source);
					const workflows =
						resolvedSource.kind === 'remote'
							? listMarketplace(resolvedSource.owner, resolvedSource.repo)
							: listMarketplaceFromRepo(resolvedSource.repoDir);

					for (const workflow of workflows) {
						logOut(formatMarketplaceWorkflow(workflow));
						found = true;
					}
				}
				if (!found) {
					logOut('No workflows found in any configured marketplace.');
				}
				return 0;
			} catch (error) {
				logError(fmtError(error));
				return 1;
			}
		}

		case 'upgrade': {
			const name = input.subcommandArgs[0];
			if (name) {
				// Upgrade a single workflow
				try {
					const updatedName = upgrade(name);
					logOut(`Upgraded workflow: ${formatWorkflowLabel(updatedName)}`);
					return 0;
				} catch (error) {
					logError(fmtError(error));
					return 1;
				}
			}

			// Upgrade all non-builtin workflows
			const builtins = new Set(listBuiltins());
			const all = list().filter(n => !builtins.has(n));
			if (all.length === 0) {
				logOut('No installed workflows to upgrade.');
				return 0;
			}

			let failures = 0;
			for (const wfName of all) {
				try {
					const updatedName = upgrade(wfName);
					logOut(`Upgraded workflow: ${formatWorkflowLabel(updatedName)}`);
				} catch (error) {
					logError(`Failed to upgrade "${wfName}": ${fmtError(error)}`);
					failures++;
				}
			}
			return failures > 0 ? 1 : 0;
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
				logError(fmtError(error));
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
			logOut(`Active workflow: ${formatWorkflowLabel(name)}`);
			return 0;
		}

		default:
			logError(USAGE);
			return 1;
	}
}
