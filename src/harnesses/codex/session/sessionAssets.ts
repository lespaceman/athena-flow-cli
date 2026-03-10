import fs from 'node:fs';
import path from 'node:path';
import type {WorkflowPlan} from '../../../core/workflows';

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

function normalizeCodexMcpServerConfig(
	serverConfig: Record<string, unknown>,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(serverConfig)) {
		if (key === 'options') {
			continue;
		}

		if (key === 'bearerTokenEnvVar') {
			normalized['bearer_token_env_var'] = value;
			continue;
		}

		normalized[key] = value;
	}

	return normalized;
}

export function resolveCodexWorkflowSkillRoots(
	workflowPlan?: WorkflowPlan,
): string[] {
	if (!workflowPlan) {
		return [];
	}

	return [
		...new Set(
			workflowPlan.pluginDirs
				.map(pluginDir => path.join(pluginDir, 'skills'))
				.filter(skillRoot => fs.existsSync(skillRoot)),
		),
	];
}

function readMcpServers(
	configPath: string,
): Record<string, Record<string, unknown>> {
	if (!configPath) {
		return {};
	}
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, 'utf-8');
	} catch {
		return {};
	}
	const parsed = JSON.parse(raw) as {
		mcpServers?: Record<string, unknown>;
	};
	const servers = asRecord(parsed['mcpServers']);
	if (!servers) {
		return {};
	}
	const result: Record<string, Record<string, unknown>> = {};
	for (const [name, config] of Object.entries(servers)) {
		const record = asRecord(config);
		if (record) {
			result[name] = normalizeCodexMcpServerConfig(record);
		}
	}
	return result;
}

/**
 * Merge session-level plugin MCP config and workflow-derived MCP config
 * into a single Codex config object. Workflow entries take precedence
 * over session-level entries with the same server name.
 */
export function resolveCodexMcpConfig(
	pluginMcpConfig?: string,
	workflowPlan?: WorkflowPlan,
): Record<string, unknown> | undefined {
	const sessionServers = pluginMcpConfig ? readMcpServers(pluginMcpConfig) : {};
	const workflowServers = workflowPlan?.pluginMcpConfig
		? readMcpServers(workflowPlan.pluginMcpConfig)
		: {};

	const merged = {...sessionServers, ...workflowServers};
	if (Object.keys(merged).length === 0) {
		return undefined;
	}
	return {mcp_servers: merged};
}
