import fs from 'node:fs';
import {readGlobalConfig} from '../../infra/plugins/config';
import {
	isMarketplaceRef,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveWorkflowMarketplaceSource,
	resolveMarketplaceWorkflow,
	findMarketplaceRepoDir,
} from '../../infra/plugins/marketplace';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

export type WorkflowOption = {
	label: string;
	value: string;
	description: string;
};

function readLocalWorkflowOption(sourcePath: string): WorkflowOption {
	const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as {
		name?: string;
		description?: string;
	};

	return {
		label: raw.name ?? sourcePath,
		value: sourcePath,
		description: raw.description ?? 'Local workflow',
	};
}

function loadOptionsFromSources(sources: string[]): WorkflowOption[] {
	const options: WorkflowOption[] = [];
	const seen = new Set<string>();

	for (const source of sources) {
		const resolved = resolveWorkflowMarketplaceSource(source);

		const workflows =
			resolved.kind === 'remote'
				? listMarketplaceWorkflows(resolved.owner, resolved.repo).map(w => ({
						label: w.name,
						value: w.ref,
						description: w.description ?? 'Marketplace workflow',
					}))
				: listMarketplaceWorkflowsFromRepo(resolved.repoDir).map(w => ({
						label: w.name,
						value: w.workflowPath,
						description: w.description ?? 'Local marketplace workflow',
					}));

		for (const wf of workflows) {
			if (!seen.has(wf.label)) {
				seen.add(wf.label);
				options.push(wf);
			}
		}
	}

	return options;
}

export function loadWorkflowOptions(): WorkflowOption[] {
	const sourceOverride = process.env.ATHENA_STARTER_WORKFLOW_SOURCE;

	if (!sourceOverride) {
		const sources = readGlobalConfig().workflowMarketplaceSources;
		return loadOptionsFromSources(
			sources && sources.length > 0 ? sources : [DEFAULT_MARKETPLACE_SLUG],
		);
	}

	if (isMarketplaceRef(sourceOverride)) {
		const workflowPath = resolveMarketplaceWorkflow(sourceOverride);
		const option = readLocalWorkflowOption(workflowPath);
		return [{...option, value: sourceOverride}];
	}

	const repoDir = findMarketplaceRepoDir(sourceOverride);
	if (repoDir) {
		return listMarketplaceWorkflowsFromRepo(repoDir).map(workflow => ({
			label: workflow.name,
			value: workflow.workflowPath,
			description: workflow.description ?? 'Local marketplace workflow',
		}));
	}

	if (!fs.existsSync(sourceOverride)) {
		throw new Error(`Workflow source not found: ${sourceOverride}`);
	}

	return [readLocalWorkflowOption(sourceOverride)];
}
