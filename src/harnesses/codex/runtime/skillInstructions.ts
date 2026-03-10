import path from 'node:path';
import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import {asRecord} from './eventTranslator';

export type CodexWorkflowSkill = {
	name: string;
	description?: string;
	path?: string;
	dependencySummary: string[];
};

export type CodexSkillInstructionsResult = {
	instructions?: string;
	skills: CodexWorkflowSkill[];
};

function isUnderAnyRoot(filePath: string, roots: string[]): boolean {
	return roots.some(root => {
		const normalizedRoot = root.endsWith(path.sep)
			? root
			: `${root}${path.sep}`;
		return filePath === root || filePath.startsWith(normalizedRoot);
	});
}

function formatSkillDependency(tool: Record<string, unknown>): string | null {
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

function extractWorkflowSkills(
	result: unknown,
	skillRoots: string[],
): CodexWorkflowSkill[] {
	const response = asRecord(result);
	const data = Array.isArray(response['data']) ? response['data'] : [];
	return data.flatMap(entry => {
		const record = asRecord(entry);
		const skills = Array.isArray(record['skills']) ? record['skills'] : [];
		return skills
			.map(skill => asRecord(skill))
			.filter((skill): skill is Record<string, unknown> => {
				if (skill['enabled'] === false) {
					return false;
				}

				const skillPath =
					typeof skill['path'] === 'string' ? skill['path'] : null;
				return skillPath !== null && isUnderAnyRoot(skillPath, skillRoots);
			})
			.map(skill => {
				const dependencies = asRecord(skill['dependencies']);
				const tools = Array.isArray(dependencies['tools'])
					? dependencies['tools']
					: [];
				return {
					name: typeof skill['name'] === 'string' ? skill['name'] : 'unknown',
					description:
						typeof skill['description'] === 'string'
							? skill['description']
							: undefined,
					path: typeof skill['path'] === 'string' ? skill['path'] : undefined,
					dependencySummary: tools
						.map(tool => asRecord(tool))
						.map(formatSkillDependency)
						.filter((value): value is string => value !== null),
				} satisfies CodexWorkflowSkill;
			});
	});
}

function buildSkillInstructions(
	workflowSkills: CodexWorkflowSkill[],
): string | undefined {
	if (workflowSkills.length === 0) {
		return undefined;
	}

	const lines = [
		'## Skills',
		'These skills are available from Athena workflow plugins in this session.',
	];

	for (const skill of workflowSkills) {
		const location = skill.path ? ` (file: ${skill.path})` : '';
		lines.push(`- ${skill.name}: ${skill.description ?? ''}${location}`);
		if (skill.dependencySummary.length > 0) {
			lines.push(`  Dependencies: ${skill.dependencySummary.join(', ')}`);
		}
	}

	lines.push(
		'If a task matches a skill description, invoke it with `$<skill-name>` and include the matching skill input item.',
	);
	return lines.join('\n');
}

export async function resolveCodexSkillInstructions(input: {
	manager: AppServerManager;
	projectDir: string;
	skillRoots?: string[];
}): Promise<CodexSkillInstructionsResult> {
	const skillRoots = input.skillRoots?.filter(Boolean) ?? [];
	if (skillRoots.length === 0) {
		return {instructions: undefined, skills: []};
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

	const skills = extractWorkflowSkills(result, skillRoots);
	return {
		instructions: buildSkillInstructions(skills),
		skills,
	};
}
