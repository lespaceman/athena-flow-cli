import {describe, it, expect} from 'vitest';
import * as fs from 'node:fs';
import {collectEnvironment} from './doctorEnvironment';

type StatMap = Record<string, {size: number; mtime: Date}>;
type FileMap = Record<string, string>;

function makeFakes(stats: StatMap, files: FileMap) {
	const statFn = (p: string): fs.Stats => {
		const entry = stats[p];
		if (!entry) {
			const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		return {
			size: entry.size,
			mtime: entry.mtime,
		} as unknown as fs.Stats;
	};
	const readFileFn = (p: string): string => {
		const content = files[p];
		if (content === undefined) {
			throw new Error(`ENOENT: ${p}`);
		}
		return content;
	};
	return {statFn, readFileFn};
}

describe('collectEnvironment', () => {
	it('reports absent scopes when no settings files exist', () => {
		const {statFn, readFileFn} = makeFakes({}, {});
		const env = collectEnvironment({
			platform: 'darwin',
			homeDir: '/Users/test',
			cwd: '/repo',
			env: {},
			resolveClaudeBinaryFn: () => null,
			detectClaudeVersionFn: () => null,
			runClaudeAuthStatusFn: () => ({ok: false, message: 'not installed'}),
			resolveHookForwarderCommandFn: () => ({
				command: 'athena-hook-forwarder',
				executable: 'athena-hook-forwarder',
				args: [],
				source: 'path' as const,
			}),
			statFn,
			readFileFn,
		});

		expect(env.claudeBinary).toBeNull();
		expect(env.settings.every(s => !s.present)).toBe(true);
		expect(env.managedPolicyKeys).toEqual([]);
		expect(env.providerEnvVars).toEqual([]);
		expect(env.apiKeyHelperOwner).toBeNull();
	});

	it('detects managed-settings policy keys and enforcement fields', () => {
		const managedPath =
			'/Library/Application Support/ClaudeCode/managed-settings.json';
		const managedJson = JSON.stringify({
			forceLoginMethod: 'claudeai',
			forceLoginOrgUUID: 'org-uuid-123',
			allowManagedHooksOnly: true,
			model: 'claude-sonnet-4-6',
		});
		const {statFn, readFileFn} = makeFakes(
			{
				[managedPath]: {
					size: managedJson.length,
					mtime: new Date('2026-04-18T12:00:00Z'),
				},
			},
			{[managedPath]: managedJson},
		);

		const env = collectEnvironment({
			platform: 'darwin',
			homeDir: '/Users/test',
			cwd: '/repo',
			env: {ANTHROPIC_API_KEY: 'sk-ant-x'},
			resolveClaudeBinaryFn: () => '/usr/local/bin/claude',
			detectClaudeVersionFn: () => '2.5.0',
			runClaudeAuthStatusFn: () => ({ok: true, message: 'ok'}),
			resolveHookForwarderCommandFn: () => ({
				command: 'node /dist/hook-forwarder.js',
				executable: 'node',
				args: ['/dist/hook-forwarder.js'],
				source: 'bundled' as const,
				scriptPath: '/dist/hook-forwarder.js',
			}),
			statFn,
			readFileFn,
		});

		expect(env.managedPolicyKeys).toContain('forceLoginMethod');
		expect(env.managedPolicyKeys).toContain('allowManagedHooksOnly');
		expect(env.enforcement.forceLoginMethod).toBe('claudeai');
		expect(env.enforcement.forceLoginOrgUUID).toBe('org-uuid-123');
		expect(env.providerEnvVars).toEqual(['ANTHROPIC_API_KEY']);
	});

	it('captures parseError for malformed settings files instead of throwing', () => {
		const userPath = '/Users/test/.claude/settings.json';
		const {statFn, readFileFn} = makeFakes(
			{[userPath]: {size: 5, mtime: new Date()}},
			{[userPath]: '{invalid json'},
		);

		const env = collectEnvironment({
			platform: 'darwin',
			homeDir: '/Users/test',
			cwd: '/repo',
			env: {},
			resolveClaudeBinaryFn: () => null,
			detectClaudeVersionFn: () => null,
			runClaudeAuthStatusFn: () => ({ok: false, message: 'n/a'}),
			resolveHookForwarderCommandFn: () => ({
				command: 'x',
				executable: 'x',
				args: [],
				source: 'path' as const,
			}),
			statFn,
			readFileFn,
		});

		const userScope = env.settings.find(s => s.scope === 'user')!;
		expect(userScope.present).toBe(true);
		expect(userScope.parseError).toBeDefined();
	});

	it('records apiKeyHelper from user settings', () => {
		const userPath = '/Users/test/.claude/settings.json';
		const userJson = JSON.stringify({apiKeyHelper: '/bin/get-key.sh'});
		const {statFn, readFileFn} = makeFakes(
			{[userPath]: {size: userJson.length, mtime: new Date()}},
			{[userPath]: userJson},
		);

		const env = collectEnvironment({
			platform: 'darwin',
			homeDir: '/Users/test',
			cwd: '/repo',
			env: {},
			resolveClaudeBinaryFn: () => null,
			detectClaudeVersionFn: () => null,
			runClaudeAuthStatusFn: () => ({ok: false, message: 'n/a'}),
			resolveHookForwarderCommandFn: () => ({
				command: 'x',
				executable: 'x',
				args: [],
				source: 'path' as const,
			}),
			statFn,
			readFileFn,
		});

		expect(env.apiKeyHelperOwner).toBe('user');
		expect(env.apiKeyHelperCommand).toBe('/bin/get-key.sh');
	});
});
