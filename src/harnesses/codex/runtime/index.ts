import {createCodexServer} from './server';

export type CodexRuntimeOptions = {
	projectDir: string;
	instanceId: number;
	binaryPath?: string;
};

export function createCodexRuntime(opts: CodexRuntimeOptions) {
	return createCodexServer(opts);
}
