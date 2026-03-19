/**
 * YAML frontmatter parser for SKILL.md files.
 */

import {type SkillFrontmatter, type ParsedSkill} from './types';
import {
	parseSimpleYaml,
	splitFrontmatter,
} from '../../shared/utils/yamlFrontmatter';

/**
 * Parse a SKILL.md file into frontmatter + body.
 * Throws if the file does not start with a `---` frontmatter block.
 */
export function parseFrontmatter(content: string): ParsedSkill {
	const {yamlLines, body} = splitFrontmatter(content, 'SKILL.md');
	const frontmatter = parseSimpleYaml(yamlLines);

	if (!frontmatter['name'] || typeof frontmatter['name'] !== 'string') {
		throw new Error('SKILL.md frontmatter must include a "name" field');
	}

	if (
		!frontmatter['description'] ||
		typeof frontmatter['description'] !== 'string'
	) {
		throw new Error('SKILL.md frontmatter must include a "description" field');
	}

	return {frontmatter: frontmatter as SkillFrontmatter, body};
}
