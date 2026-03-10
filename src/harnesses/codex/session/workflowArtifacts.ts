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

export function resolveCodexWorkflowConfig(
	workflowPlan?: WorkflowPlan,
): Record<string, unknown> | undefined {
	const pluginMcpConfig = workflowPlan?.pluginMcpConfig;
	if (!pluginMcpConfig || !fs.existsSync(pluginMcpConfig)) {
		return undefined;
	}

	const parsed = JSON.parse(fs.readFileSync(pluginMcpConfig, 'utf-8')) as {
		mcpServers?: Record<string, unknown>;
	};
	const servers = asRecord(parsed['mcpServers']);
	if (!servers || Object.keys(servers).length === 0) {
		return undefined;
	}

	const normalizedServers = Object.fromEntries(
		Object.entries(servers)
			.map(([name, config]) => {
				const record = asRecord(config);
				if (!record) {
					return null;
				}
				return [name, normalizeCodexMcpServerConfig(record)] as const;
			})
			.filter(
				(
					entry,
				): entry is readonly [string, Record<string, unknown>] => entry !== null,
			),
	);

	if (Object.keys(normalizedServers).length === 0) {
		return undefined;
	}

	return {mcp_servers: normalizedServers};
}
