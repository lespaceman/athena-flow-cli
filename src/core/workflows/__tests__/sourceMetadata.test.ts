import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
	readWorkflowSourceMetadata,
	writeWorkflowSourceMetadata,
} from '../sourceMetadata';

describe('readWorkflowSourceMetadata', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-srcmeta-'));
	});
	afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

	it('returns undefined when no source.json exists', () => {
		expect(readWorkflowSourceMetadata(tmp)).toBeUndefined();
	});

	it('reads v2 marketplace-remote', () => {
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({
				v: 2,
				kind: 'marketplace-remote',
				ref: 'w@o/r',
				version: '1.0.0',
			}),
		);
		expect(readWorkflowSourceMetadata(tmp)).toEqual({
			kind: 'marketplace-remote',
			ref: 'w@o/r',
			version: '1.0.0',
		});
	});

	it('reads v2 marketplace-local', () => {
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({
				v: 2,
				kind: 'marketplace-local',
				repoDir: '/tmp/m',
				workflowName: 'w',
			}),
		);
		expect(readWorkflowSourceMetadata(tmp)).toEqual({
			kind: 'marketplace-local',
			repoDir: '/tmp/m',
			workflowName: 'w',
		});
	});

	it('migrates legacy {kind: "marketplace", ref}', () => {
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({kind: 'marketplace', ref: 'w@o/r'}),
		);
		expect(readWorkflowSourceMetadata(tmp)).toEqual({
			kind: 'marketplace-remote',
			ref: 'w@o/r',
		});
	});

	it('migrates legacy {kind: "local", path, repoDir} when repoDir has a workflow manifest', () => {
		const repo = path.join(tmp, 'm');
		fs.mkdirSync(path.join(repo, '.athena-workflow'), {recursive: true});
		fs.writeFileSync(
			path.join(repo, '.athena-workflow', 'marketplace.json'),
			JSON.stringify({
				name: 'm',
				owner: {name: 't'},
				plugins: [],
				workflows: [{name: 'w', source: './workflows/w/workflow.json'}],
			}),
		);
		fs.mkdirSync(path.join(repo, 'workflows', 'w'), {recursive: true});
		const wfPath = path.join(repo, 'workflows', 'w', 'workflow.json');
		fs.writeFileSync(wfPath, '{}');
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({kind: 'local', path: wfPath, repoDir: repo}),
		);

		expect(readWorkflowSourceMetadata(tmp)).toEqual({
			kind: 'marketplace-local',
			repoDir: fs.realpathSync(repo),
			workflowName: 'w',
		});
	});

	it('migrates legacy {kind: "local", path} without repoDir to filesystem kind when path is a loose workflow.json', () => {
		fs.writeFileSync(path.join(tmp, 'loose.json'), '{}');
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({kind: 'local', path: path.join(tmp, 'loose.json')}),
		);
		expect(readWorkflowSourceMetadata(tmp)).toEqual({
			kind: 'filesystem',
			path: path.join(tmp, 'loose.json'),
		});
	});

	it('throws on invalid JSON', () => {
		fs.writeFileSync(path.join(tmp, 'source.json'), '{not json');
		expect(() => readWorkflowSourceMetadata(tmp)).toThrow(/not valid JSON/);
	});

	it('throws on unknown kind', () => {
		fs.writeFileSync(
			path.join(tmp, 'source.json'),
			JSON.stringify({v: 2, kind: 'nonsense'}),
		);
		expect(() => readWorkflowSourceMetadata(tmp)).toThrow(/supported/);
	});
});

describe('writeWorkflowSourceMetadata', () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-srcmeta-'));
	});
	afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

	it('writes v2 payload', () => {
		writeWorkflowSourceMetadata(tmp, {
			kind: 'marketplace-remote',
			ref: 'w@o/r',
			version: '1.0.0',
		});
		const raw = JSON.parse(
			fs.readFileSync(path.join(tmp, 'source.json'), 'utf-8'),
		);
		expect(raw).toEqual({
			v: 2,
			kind: 'marketplace-remote',
			ref: 'w@o/r',
			version: '1.0.0',
		});
	});
});
