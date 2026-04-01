/**
 * Workflow plugin installer.
 *
 * Resolves marketplace plugin refs from a workflow's plugins array
 * into absolute directory paths using the existing marketplace resolver.
 */

import {
	resolveMarketplacePluginTarget,
	resolveMarketplacePluginTargetFromRepo,
	resolveVersionedMarketplacePluginTarget,
} from '../../infra/plugins/marketplace';
import type {
	CodexWorkflowPluginRef,
	ResolvedLocalWorkflowPlugin,
	ResolvedWorkflowConfig,
	WorkflowConfig,
} from './types';
import {pluginSpecRef, pluginSpecVersion} from './types';

/**
 * Resolve all plugins listed in a workflow to absolute directory paths.
 * Uses the marketplace resolver for `name@owner/repo` refs.
 * Throws on the first plugin that fails to resolve, with the specific ref in the message.
 */
export function installWorkflowPlugins(
	workflow: WorkflowConfig | ResolvedWorkflowConfig,
): string[] {
	return resolveWorkflowPlugins(workflow).localPlugins.map(p => p.pluginDir);
}

export type ResolvedWorkflowPlugins = {
	localPlugins: ResolvedLocalWorkflowPlugin[];
	codexPlugins: CodexWorkflowPluginRef[];
};

export function resolveWorkflowPlugins(
	workflow: WorkflowConfig | ResolvedWorkflowConfig,
): ResolvedWorkflowPlugins {
	const resolved = workflow.plugins.map(spec => {
		const ref = pluginSpecRef(spec);
		const version = pluginSpecVersion(spec);

		try {
			const source = '__source' in workflow ? workflow.__source : undefined;

			if (version) {
				return resolveVersionedMarketplacePluginTarget(
					ref,
					version,
					source?.kind === 'local' ? source.repoDir : undefined,
				);
			}

			if (source?.kind === 'local' && source.repoDir) {
				return resolveMarketplacePluginTargetFromRepo(ref, source.repoDir);
			}
			return resolveMarketplacePluginTarget(ref);
		} catch (error) {
			throw new Error(
				`Workflow "${workflow.name}": failed to install plugin "${ref}": ${(error as Error).message}`,
			);
		}
	});

	return {
		localPlugins: resolved.map(p => ({ref: p.ref, pluginDir: p.pluginDir})),
		codexPlugins: resolved.map(p => ({
			ref: p.ref,
			pluginName: p.pluginName,
			marketplacePath: p.marketplacePath,
		})),
	};
}
