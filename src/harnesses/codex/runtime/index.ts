import {createCodexServer} from './server';
import type {CodexServerOptions} from './server';

export type {CodexServerOptions as CodexRuntimeOptions} from './server';

export function createCodexRuntime(opts: CodexServerOptions) {
	return createCodexServer(opts);
}
