import type {Runtime} from '../../core/runtime/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import {createClaudeHookRuntime} from '../../harnesses/claude/runtime';
import {createCodexRuntime} from '../../harnesses/codex/runtime';

export type RuntimeFactoryInput = {
	harness: AthenaHarness;
	projectDir: string;
	instanceId: number;
};

export type RuntimeFactory = (input: RuntimeFactoryInput) => Runtime;

export const DEFAULT_HARNESS: AthenaHarness = 'claude-code';

export function createRuntime(input: RuntimeFactoryInput): Runtime {
	switch (input.harness) {
		case 'claude-code':
			return createClaudeHookRuntime({
				projectDir: input.projectDir,
				instanceId: input.instanceId,
			});
		case 'openai-codex':
			return createCodexRuntime({
				projectDir: input.projectDir,
				instanceId: input.instanceId,
			});
		case 'opencode':
		default:
			// Backward-compatible fallback until additional harness adapters land.
			return createClaudeHookRuntime({
				projectDir: input.projectDir,
				instanceId: input.instanceId,
			});
	}
}
