import path from 'node:path';
import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import type {WorkflowPluginTarget} from '../../../core/workflows';

export type CodexInstalledWorkflowPlugin = {
	ref: string;
	pluginName: string;
	marketplacePath: string;
};

export async function ensureCodexWorkflowPluginsInstalled(input: {
	manager: AppServerManager;
	projectDir: string;
	pluginTargets?: WorkflowPluginTarget[];
}): Promise<CodexInstalledWorkflowPlugin[]> {
	const pluginTargets =
		input.pluginTargets?.filter(target => target.marketplacePath.length > 0) ??
		[];
	if (pluginTargets.length === 0) {
		return [];
	}

	// Trigger marketplace discovery for the current cwd first so Codex resolves
	// repo-scoped marketplaces using its own marketplace manager semantics.
	await input.manager.sendRequest(M.PLUGIN_LIST, {
		cwds: [input.projectDir],
	});

	const installed: CodexInstalledWorkflowPlugin[] = [];
	for (const target of pluginTargets) {
		await input.manager.sendRequest(M.PLUGIN_INSTALL, {
			marketplacePath: target.marketplacePath,
			pluginName: target.pluginName,
		});
		installed.push({
			ref: target.ref,
			pluginName: target.pluginName,
			marketplacePath: target.marketplacePath,
		});
	}

	return installed;
}

export function buildCodexPluginInstallMessage(
	plugins: CodexInstalledWorkflowPlugin[],
): string {
	if (plugins.length === 0) {
		return 'No workflow plugins required Codex-native installation.';
	}

	const names = plugins.map(
		plugin =>
			`${plugin.pluginName} (${path.basename(path.dirname(path.dirname(plugin.marketplacePath)))})`,
	);
	return `Ensured ${plugins.length} workflow plugin${plugins.length === 1 ? '' : 's'} via Codex: ${names.join(', ')}.`;
}
