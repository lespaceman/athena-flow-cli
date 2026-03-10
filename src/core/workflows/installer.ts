/**
 * Workflow plugin installer.
 *
 * Resolves marketplace plugin refs from a workflow's plugins array
 * into absolute directory paths using the existing marketplace resolver.
 */

import {
	resolveMarketplacePlugin,
	resolveMarketplacePluginFromRepo,
} from '../../infra/plugins/marketplace';
import type {ResolvedWorkflowConfig, WorkflowConfig} from './types';

/**
 * Resolve all plugins listed in a workflow to absolute directory paths.
 * Uses the marketplace resolver for `name@owner/repo` refs.
 * Throws on the first plugin that fails to resolve, with the specific ref in the message.
 */
export function installWorkflowPlugins(
	workflow: WorkflowConfig | ResolvedWorkflowConfig,
): string[] {
	return workflow.plugins.map(ref => {
		try {
			const source = '__source' in workflow ? workflow.__source : undefined;
			if (source?.kind === 'local' && source.repoDir) {
				return resolveMarketplacePluginFromRepo(ref, source.repoDir);
			}
			return resolveMarketplacePlugin(ref);
		} catch (error) {
			throw new Error(
				`Workflow "${workflow.name}": failed to install plugin "${ref}": ${(error as Error).message}`,
			);
		}
	});
}
