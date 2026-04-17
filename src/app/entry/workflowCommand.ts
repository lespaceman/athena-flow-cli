import {
	installWorkflow,
	installWorkflowFromSource,
	listBuiltinWorkflows,
	listWorkflows,
	removeWorkflow,
	resolveWorkflow,
	updateWorkflow,
} from '../../core/workflows/index';
import {
	formatWorkflowListingSource,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveWorkflowInstall,
	resolveWorkflowInstallSourceFromSources,
	resolveWorkflowMarketplaceSource,
	type MarketplaceWorkflowListing,
} from '../../infra/plugins/marketplace';
import {
	projectConfigPath,
	readConfig,
	readGlobalConfig,
	resolveActiveWorkflow,
	writeGlobalConfig,
	writeProjectConfig,
} from '../../infra/plugins/config';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

const USAGE = `Usage: athena-flow workflow <subcommand>

Subcommands
  install <source>   Install a workflow from a name, file path, or marketplace ref
                     (name supports @version pinning, e.g. e2e-test-builder@1.2.3)
  list               List installed workflows
  search             Browse available workflows across all configured marketplaces
  remove <name>      Remove an installed workflow
  upgrade [name]     Re-sync installed workflow(s) from their recorded source
  use <name>         Set the active workflow
                     --project   Pin to project (.athena/config.json)
                     --global    Set globally (default)
  status             Show effective active workflow, scope, and configured layers`;

export type WorkflowCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	projectDir: string;
};

export type WorkflowCommandDeps = {
	installWorkflow?: typeof installWorkflow;
	installWorkflowFromSource?: typeof installWorkflowFromSource;
	listWorkflows?: typeof listWorkflows;
	listBuiltinWorkflows?: typeof listBuiltinWorkflows;
	removeWorkflow?: typeof removeWorkflow;
	updateWorkflow?: typeof updateWorkflow;
	resolveWorkflow?: typeof resolveWorkflow;
	listMarketplaceWorkflows?: typeof listMarketplaceWorkflows;
	listMarketplaceWorkflowsFromRepo?: typeof listMarketplaceWorkflowsFromRepo;
	resolveWorkflowInstall?: typeof resolveWorkflowInstall;
	// Legacy field retained for now (removed in Task 12):
	resolveWorkflowInstallSourceFromSources?: typeof resolveWorkflowInstallSourceFromSources;
	resolveWorkflowMarketplaceSource?: typeof resolveWorkflowMarketplaceSource;
	readGlobalConfig?: typeof readGlobalConfig;
	readProjectConfig?: typeof readConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	writeProjectConfig?: typeof writeProjectConfig;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

type UseFlags = {
	project: boolean;
	global: boolean;
	positional: string[];
};

function parseUseFlags(args: string[]): UseFlags | {error: string} {
	let project = false;
	let global = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (arg === '--project') {
			project = true;
		} else if (arg === '--global') {
			global = true;
		} else if (arg.startsWith('--')) {
			return {error: `Unknown flag for workflow use: ${arg}`};
		} else {
			positional.push(arg);
		}
	}
	if (project && global) {
		return {
			error: 'workflow use: --project and --global are mutually exclusive',
		};
	}
	return {project, global, positional};
}

function updateConfigWorkflow(
	config: ReturnType<typeof readGlobalConfig>,
	name: string,
): ReturnType<typeof readGlobalConfig> {
	return {...config, activeWorkflow: name};
}

export function runWorkflowCommand(
	input: WorkflowCommandInput,
	deps: WorkflowCommandDeps = {},
): number {
	const list = deps.listWorkflows ?? listWorkflows;
	const listBuiltins = deps.listBuiltinWorkflows ?? listBuiltinWorkflows;
	const remove = deps.removeWorkflow ?? removeWorkflow;
	const resolveInstalledWorkflow = deps.resolveWorkflow ?? resolveWorkflow;
	const upgrade = deps.updateWorkflow ?? updateWorkflow;
	const listMarketplace =
		deps.listMarketplaceWorkflows ?? listMarketplaceWorkflows;
	const listMarketplaceFromRepo =
		deps.listMarketplaceWorkflowsFromRepo ?? listMarketplaceWorkflowsFromRepo;
	const resolveMarketplaceSource =
		deps.resolveWorkflowMarketplaceSource ?? resolveWorkflowMarketplaceSource;
	const readGlobal = deps.readGlobalConfig ?? readGlobalConfig;
	const readProject = deps.readProjectConfig ?? readConfig;
	const writeGlobal = deps.writeGlobalConfig ?? writeGlobalConfig;
	const writeProject = deps.writeProjectConfig ?? writeProjectConfig;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	const fmtError = (error: unknown): string =>
		`Error: ${error instanceof Error ? error.message : String(error)}`;

	const formatMarketplaceWorkflow = (
		entry: MarketplaceWorkflowListing,
	): string => {
		const version = entry.version ? ` (${entry.version})` : '';
		const description = entry.description ? ` - ${entry.description}` : '';
		const sourceLabel = formatWorkflowListingSource(entry.source);
		return `${entry.name}${version}${description} [from ${sourceLabel}]`;
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
		const sources = readGlobal().workflowMarketplaceSources;
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
				const resolveInstall =
					deps.resolveWorkflowInstall ?? resolveWorkflowInstall;
				const installFromSource =
					deps.installWorkflowFromSource ?? installWorkflowFromSource;
				const resolved = resolveInstall(source, getMarketplaceSources());
				const name = installFromSource(resolved);
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
				if (readGlobal().activeWorkflow === name) {
					writeGlobal({activeWorkflow: undefined});
					logOut('Active workflow cleared.');
				}
				if (readProject(input.projectDir).activeWorkflow === name) {
					writeProject(input.projectDir, {activeWorkflow: undefined});
					logOut('Project active workflow cleared.');
				}
				logOut(`Removed workflow: ${name}`);
				return 0;
			} catch (error) {
				logError(fmtError(error));
				return 1;
			}
		}

		case 'use': {
			const parsed = parseUseFlags(input.subcommandArgs);
			if ('error' in parsed) {
				logError(parsed.error);
				return 1;
			}
			const name = parsed.positional[0];
			if (!name) {
				logError('Usage: athena-flow workflow use [--project|--global] <name>');
				return 1;
			}

			const installed = list();
			if (!installed.includes(name)) {
				logError(`Error: Workflow "${name}" is not installed.`);
				return 1;
			}

			const globalConfig = readGlobal();
			const projectConfig = readProject(input.projectDir);
			const target: 'project' | 'global' = parsed.project
				? 'project'
				: 'global';
			const projectPath = projectConfigPath(input.projectDir);
			if (target === 'project') {
				writeProject(input.projectDir, {activeWorkflow: name});
				logOut(
					`Active workflow: ${formatWorkflowLabel(name)} [project: ${projectPath}]`,
				);
			} else {
				writeGlobal({activeWorkflow: name});
				const effective = resolveActiveWorkflow({
					globalConfig: updateConfigWorkflow(globalConfig, name),
					projectConfig,
				});
				logOut(`Active workflow: ${formatWorkflowLabel(name)} [global]`);
				if (effective.source === 'project') {
					logOut(
						`Effective workflow remains ${formatWorkflowLabel(effective.name)} [project: ${projectPath}] because the project config overrides global.`,
					);
					logOut(`Use --project to update ${projectPath}.`);
				}
			}
			return 0;
		}

		case 'status': {
			const projectConfig = readProject(input.projectDir);
			const globalConfig = readGlobal();
			const selection = resolveActiveWorkflow({globalConfig, projectConfig});
			logOut(
				`Active workflow: ${formatWorkflowLabel(selection.name)} [${selection.source}]`,
			);
			logOut(`  global:  ${globalConfig.activeWorkflow ?? '(unset)'}`);
			logOut(`  project: ${projectConfig.activeWorkflow ?? '(unset)'}`);
			if (selection.source === 'project' && globalConfig.activeWorkflow) {
				logOut(
					`  note: project config overrides global at ${projectConfigPath(input.projectDir)}`,
				);
			}
			return 0;
		}

		default:
			logError(USAGE);
			return 1;
	}
}
