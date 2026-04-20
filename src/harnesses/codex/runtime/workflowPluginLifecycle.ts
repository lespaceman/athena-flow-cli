import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import type {CodexWorkflowPluginRef} from '../../../core/workflows';

export type CodexInstalledWorkflowPlugin = CodexWorkflowPluginRef & {
	marketplaceName?: string;
};

type PluginReadResponse = {
	plugin?: {
		marketplaceName?: string;
		marketplacePath?: string;
		summary?: {
			installed?: boolean;
		};
	};
};

function isPluginInstalled(response: unknown): boolean {
	if (typeof response !== 'object' || response === null) {
		return false;
	}

	return (response as PluginReadResponse).plugin?.summary?.installed === true;
}

async function readWorkflowPluginInstallationState(input: {
	manager: AppServerManager;
	plugin: CodexWorkflowPluginRef;
}): Promise<CodexInstalledWorkflowPlugin | null> {
	const response = await input.manager.sendRequest(M.PLUGIN_READ, {
		marketplacePath: input.plugin.marketplacePath,
		pluginName: input.plugin.pluginName,
	});
	if (!isPluginInstalled(response)) {
		return null;
	}
	const marketplaceName =
		typeof (response as PluginReadResponse).plugin?.marketplaceName === 'string'
			? (response as PluginReadResponse).plugin?.marketplaceName
			: undefined;
	const installedMarketplacePath =
		typeof (response as PluginReadResponse).plugin?.marketplacePath === 'string'
			? (response as PluginReadResponse).plugin?.marketplacePath
			: undefined;
	const matchesExpectedArtifact =
		installedMarketplacePath === undefined ||
		installedMarketplacePath === input.plugin.marketplacePath;
	if (!matchesExpectedArtifact) {
		return null;
	}
	return {
		...input.plugin,
		...(marketplaceName ? {marketplaceName} : {}),
	};
}

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

	const installedPlugins: CodexInstalledWorkflowPlugin[] = [];
	for (const plugin of plugins) {
		const installedBefore = await readWorkflowPluginInstallationState({
			manager: input.manager,
			plugin,
		});
		if (installedBefore) {
			installedPlugins.push(installedBefore);
			continue;
		}

		await input.manager.sendRequest(M.PLUGIN_INSTALL, {
			marketplacePath: plugin.marketplacePath,
			pluginName: plugin.pluginName,
		});

		const installedAfter = await readWorkflowPluginInstallationState({
			manager: input.manager,
			plugin,
		});
		if (installedAfter) {
			installedPlugins.push(installedAfter);
		} else {
			throw new Error(
				`Codex app-server did not report workflow plugin as installed: ${plugin.pluginName}`,
			);
		}
	}

	return installedPlugins;
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
