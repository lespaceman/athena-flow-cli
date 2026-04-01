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
	ResolvedWorkflowPlugin,
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
	return resolveWorkflowPlugins(workflow).resolvedPlugins.map(
		plugin => plugin.claudeArtifactDir,
	);
}

export type ResolvedWorkflowPlugins = {
	resolvedPlugins: ResolvedWorkflowPlugin[];
	localPlugins: ResolvedLocalWorkflowPlugin[];
	codexPlugins: CodexWorkflowPluginRef[];
};

function marketplaceNameFromRef(ref: string): string {
	return ref.slice(ref.indexOf('@') + 1);
}

export function resolveWorkflowPlugins(
	workflow: WorkflowConfig | ResolvedWorkflowConfig,
): ResolvedWorkflowPlugins {
	const resolvedPlugins = workflow.plugins.map(spec => {
		const ref = pluginSpecRef(spec);
		const version = pluginSpecVersion(spec);

		try {
			const source = '__source' in workflow ? workflow.__source : undefined;

			if (version) {
				const target = resolveVersionedMarketplacePluginTarget(
					ref,
					version,
					source?.kind === 'local' ? source.repoDir : undefined,
				);
				return {
					ref: target.ref,
					pluginName: target.pluginName,
					marketplaceName: marketplaceNameFromRef(ref),
					version,
					pluginDir: target.pluginDir,
					claudeArtifactDir: target.pluginDir,
					codexPluginDir: target.pluginDir,
					codexMarketplacePath: target.marketplacePath,
				} satisfies ResolvedWorkflowPlugin;
			}

			if (source?.kind === 'local' && source.repoDir) {
				const target = resolveMarketplacePluginTargetFromRepo(
					ref,
					source.repoDir,
				);
				return {
					ref: target.ref,
					pluginName: target.pluginName,
					marketplaceName: marketplaceNameFromRef(ref),
					pluginDir: target.pluginDir,
					claudeArtifactDir: target.pluginDir,
					codexPluginDir: target.pluginDir,
					codexMarketplacePath: target.marketplacePath,
				} satisfies ResolvedWorkflowPlugin;
			}
			const target = resolveMarketplacePluginTarget(ref);
			return {
				ref: target.ref,
				pluginName: target.pluginName,
				marketplaceName: marketplaceNameFromRef(ref),
				pluginDir: target.pluginDir,
				claudeArtifactDir: target.pluginDir,
				codexPluginDir: target.pluginDir,
				codexMarketplacePath: target.marketplacePath,
			} satisfies ResolvedWorkflowPlugin;
		} catch (error) {
			throw new Error(
				`Workflow "${workflow.name}": failed to install plugin "${ref}": ${(error as Error).message}`,
			);
		}
	});

	return {
		resolvedPlugins,
		localPlugins: resolvedPlugins.map(p => ({
			ref: p.ref,
			pluginDir: p.claudeArtifactDir,
		})),
		codexPlugins: resolvedPlugins.map(p => ({
			ref: p.ref,
			pluginName: p.pluginName,
			marketplacePath: p.codexMarketplacePath,
		})),
	};
}
