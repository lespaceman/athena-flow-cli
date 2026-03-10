import path from 'node:path';
import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import {asRecord} from './eventTranslator';

function isUnderAnyRoot(filePath: string, roots: string[]): boolean {
	return roots.some(root => {
		const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
		return filePath === root || filePath.startsWith(normalizedRoot);
	});
}

function formatSkillDependency(
	tool: Record<string, unknown>,
): string | null {
	const type = typeof tool['type'] === 'string' ? tool['type'] : null;
	const value = typeof tool['value'] === 'string' ? tool['value'] : null;
	if (!type || !value) {
		return null;
	}

	if (type === 'mcp') {
		return `MCP server \`${value}\``;
	}

	if (type === 'env_var') {
		return `env var \`${value}\``;
	}

	return `${type} \`${value}\``;
}

function buildSkillInstructionsFromResult(
	result: unknown,
	skillRoots: string[],
): string | undefined {
	const response = asRecord(result);
	const data = Array.isArray(response['data']) ? response['data'] : [];
	const workflowSkills = data.flatMap(entry => {
		const record = asRecord(entry);
		const skills = Array.isArray(record?.['skills']) ? record['skills'] : [];
		return skills
			.map(skill => asRecord(skill))
			.filter((skill): skill is Record<string, unknown> => {
				if (!skill) {
					return false;
				}

				if (skill['enabled'] === false) {
					return false;
				}

				const skillPath =
					typeof skill['path'] === 'string' ? skill['path'] : null;
				return skillPath !== null && isUnderAnyRoot(skillPath, skillRoots);
			});
	});

	if (workflowSkills.length === 0) {
		return undefined;
	}

	const lines = [
		'## Skills',
		'These skills are available from Athena workflow plugins in this session.',
	];

	for (const skill of workflowSkills) {
		const name = typeof skill['name'] === 'string' ? skill['name'] : 'unknown';
		const description =
			typeof skill['description'] === 'string' ? skill['description'] : '';
		const skillPath =
			typeof skill['path'] === 'string' ? skill['path'] : undefined;
		const dependencies = asRecord(skill['dependencies']);
		const tools = Array.isArray(dependencies?.['tools'])
			? dependencies['tools']
			: [];
		const dependencySummary = tools
			.map(tool => asRecord(tool))
			.filter((tool): tool is Record<string, unknown> => tool !== null)
			.map(formatSkillDependency)
			.filter((value): value is string => value !== null);
		const location = skillPath ? ` (file: ${skillPath})` : '';
		lines.push(`- ${name}: ${description}${location}`);
		if (dependencySummary.length > 0) {
			lines.push(`  Dependencies: ${dependencySummary.join(', ')}`);
		}
	}

	lines.push('If a task matches a skill description, invoke it with `$<skill-name>` and include the matching skill input item.');
	return lines.join('\n');
}

export async function resolveCodexSkillInstructions(input: {
	manager: AppServerManager;
	projectDir: string;
	skillRoots?: string[];
}): Promise<string | undefined> {
	const skillRoots = input.skillRoots?.filter(Boolean) ?? [];
	if (skillRoots.length === 0) {
		return undefined;
	}

	const result = await input.manager.sendRequest(M.SKILLS_LIST, {
		cwds: [input.projectDir],
		forceReload: true,
		perCwdExtraUserRoots: [
			{
				cwd: input.projectDir,
				extraUserRoots: skillRoots,
			},
		],
	});

	return buildSkillInstructionsFromResult(result, skillRoots);
}
