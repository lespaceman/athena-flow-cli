import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {writeProjectConfig, hasProjectWorkflow, readConfig} from './config';

describe('writeProjectConfig', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-config-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('creates .athena/config.json with updates when file does not exist', () => {
		writeProjectConfig(tmpDir, {activeWorkflow: 'my-workflow'});
		const config = readConfig(tmpDir);
		expect(config.activeWorkflow).toBe('my-workflow');
	});

	it('merges with existing project config', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({plugins: ['./my-plugin'], theme: 'light'}),
		);
		writeProjectConfig(tmpDir, {activeWorkflow: 'e2e-testing'});
		const raw = JSON.parse(
			fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
		);
		expect(raw.activeWorkflow).toBe('e2e-testing');
		expect(raw.plugins).toEqual(['./my-plugin']);
		expect(raw.theme).toBe('light');
	});

	it('merges workflowSelections instead of replacing', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({
				workflowSelections: {old: {mcpServerOptions: {s1: ['a']}}},
			}),
		);
		writeProjectConfig(tmpDir, {
			workflowSelections: {new: {mcpServerOptions: {s2: ['b']}}},
		});
		const raw = JSON.parse(
			fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
		);
		expect(raw.workflowSelections).toEqual({
			old: {mcpServerOptions: {s1: ['a']}},
			new: {mcpServerOptions: {s2: ['b']}},
		});
	});
});

describe('hasProjectWorkflow', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-config-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('returns false when no config file exists', () => {
		expect(hasProjectWorkflow(tmpDir)).toBe(false);
	});

	it('returns false when config exists but has no activeWorkflow', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({plugins: []}),
		);
		expect(hasProjectWorkflow(tmpDir)).toBe(false);
	});

	it('returns true when config has activeWorkflow', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({activeWorkflow: 'my-workflow'}),
		);
		expect(hasProjectWorkflow(tmpDir)).toBe(true);
	});
});
