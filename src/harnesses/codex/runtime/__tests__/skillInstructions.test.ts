import {describe, expect, it, vi} from 'vitest';
import {resolveCodexSkillInstructions} from '../skillInstructions';

describe('resolveCodexSkillInstructions', () => {
	it('omits disabled workflow skills from injected instructions', async () => {
		const manager = {
			sendRequest: vi.fn().mockResolvedValue({
				data: [
					{
						cwd: '/project',
						skills: [
							{
								name: 'enabled-skill',
								description: 'Visible to Codex',
								enabled: true,
								path: '/workflow/plugins/e2e-test-builder/skills/enabled/SKILL.md',
							},
							{
								name: 'disabled-skill',
								description: 'Should stay hidden',
								enabled: false,
								path: '/workflow/plugins/e2e-test-builder/skills/disabled/SKILL.md',
							},
						],
						errors: [
							{
								path: '/workflow/plugins/e2e-test-builder/skills/broken/SKILL.md',
								message:
									'invalid description: exceeds maximum length of 1024 characters',
							},
						],
					},
				],
			}),
		};

		const result = await resolveCodexSkillInstructions({
			manager: manager as never,
			projectDir: '/project',
			skillRoots: ['/workflow/plugins/e2e-test-builder/skills'],
		});

		expect(manager.sendRequest).toHaveBeenCalledWith('skills/list', {
			cwds: ['/project'],
			forceReload: true,
			perCwdExtraUserRoots: [
				{
					cwd: '/project',
					extraUserRoots: ['/workflow/plugins/e2e-test-builder/skills'],
				},
			],
		});
		expect(result.instructions).toContain('enabled-skill');
		expect(result.instructions).not.toContain('disabled-skill');
		expect(result.instructions).toContain('Unavailable workflow skills:');
		expect(result.instructions).toContain(
			'invalid description: exceeds maximum length of 1024 characters',
		);
		expect(result.skills).toEqual([
			expect.objectContaining({
				name: 'enabled-skill',
				path: '/workflow/plugins/e2e-test-builder/skills/enabled/SKILL.md',
			}),
		]);
		expect(result.errors).toEqual([
			{
				path: '/workflow/plugins/e2e-test-builder/skills/broken/SKILL.md',
				message:
					'invalid description: exceeds maximum length of 1024 characters',
			},
		]);
	});
});
