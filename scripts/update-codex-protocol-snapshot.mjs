import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(
	repoRoot,
	'src/harnesses/codex/protocol/generated',
);
const schemaRoot = path.join(outputRoot, 'schema');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'athena-codex-protocol-'));
const tsOut = path.join(tempRoot, 'ts');
const schemaOut = path.join(tempRoot, 'schema');

try {
	execFileSync(
		'codex',
		['app-server', 'generate-ts', '--out', tsOut, '--experimental'],
		{
			stdio: 'inherit',
			cwd: repoRoot,
		},
	);
	execFileSync(
		'codex',
		['app-server', 'generate-json-schema', '--out', schemaOut],
		{
			stdio: 'inherit',
			cwd: repoRoot,
		},
	);

	rmSync(outputRoot, {recursive: true, force: true});
	cpSync(tsOut, outputRoot, {recursive: true});
	cpSync(schemaOut, schemaRoot, {recursive: true});
} finally {
	rmSync(tempRoot, {recursive: true, force: true});
}
