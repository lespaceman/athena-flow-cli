import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import type {CodexWorkflowPluginRef} from '../../../core/workflows';

export type CodexInstalledWorkflowPlugin = CodexWorkflowPluginRef;

export async function ensureCodexWorkflowPluginsInstalled(input: {
	manager: AppServerManager;
	projectDir: string;
	plugins?: CodexWorkflowPluginRef[];
}): Promise<CodexInstalledWorkflowPlugin[]> {
	const plugins =
		input.plugins?.filter(plugin => plugin.marketplacePath.length > 0) ?? [];
	if (plugins.length === 0) {
		return [];
	}

	for (const plugin of plugins) {
		await input.manager.sendRequest(M.PLUGIN_INSTALL, {
			marketplacePath: plugin.marketplacePath,
			pluginName: plugin.pluginName,
		});
	}

	return plugins;
}

export function buildCodexPluginInstallMessage(
	plugins: CodexInstalledWorkflowPlugin[],
): string {
	if (plugins.length === 0) {
		return 'No workflow plugins required Codex-native installation.';
	}

	const names = plugins.map(plugin => `${plugin.pluginName} (${plugin.ref})`);
	return `Ensured ${plugins.length} workflow plugin${plugins.length === 1 ? '' : 's'} via Codex: ${names.join(', ')}.`;
}
