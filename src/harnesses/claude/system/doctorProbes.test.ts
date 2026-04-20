import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildApiKeyHelperSettings,
	buildProbeConfigs,
	classifyFailure,
	DOCTOR_EXPECTED,
	formatProbeCommand,
	lookupAllCredentials,
	lookupCredential,
	makeSkippedProbe,
	probeSkipReason,
	type ProbeResult,
} from './doctorProbes';

describe('lookupCredential', () => {
	// Default isolation: no settings files readable, no helper executable, no
	// keychain entries. Individual tests override what they need.
	const isolated = () => ({
		readFileFn: () => {
			throw new Error('ENOENT');
		},
		runHelperFn: () => null,
		keychainLookupFn: () => null,
	});

	it('prefers ANTHROPIC_API_KEY env when set with sk-ant- prefix', () => {
		const result = lookupCredential({
			...isolated(),
			env: {
				ANTHROPIC_API_KEY: 'sk-ant-test123',
				ANTHROPIC_AUTH_TOKEN: 'should-be-ignored',
			},
			platform: 'darwin',
		});
		expect(result).toEqual({
			source: 'env:ANTHROPIC_API_KEY',
			kind: 'apiKey',
			value: 'sk-ant-test123',
		});
	});

	it('falls through to ANTHROPIC_AUTH_TOKEN when API key is missing or malformed', () => {
		const result = lookupCredential({
			...isolated(),
			env: {
				ANTHROPIC_API_KEY: 'wrong-prefix',
				ANTHROPIC_AUTH_TOKEN: 'bearer-token-xyz',
			},
			platform: 'linux',
		});
		expect(result).toEqual({
			source: 'env:ANTHROPIC_AUTH_TOKEN',
			kind: 'authToken',
			value: 'bearer-token-xyz',
		});
	});

	it('reads CLAUDE_CODE_OAUTH_TOKEN env when no other credential is set', () => {
		const result = lookupCredential({
			...isolated(),
			env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-long-lived'},
			platform: 'linux',
		});
		expect(result).toEqual({
			source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
			kind: 'oauthToken',
			value: 'sk-ant-oat01-long-lived',
		});
	});

	it('runs apiKeyHelper from user settings before falling back to OAuth sources', () => {
		const settingsJson = JSON.stringify({apiKeyHelper: '/bin/get-key.sh'});
		const result = lookupCredential({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			readFileFn: p => {
				if (p === '/home/user/.claude/settings.json') return settingsJson;
				throw new Error('ENOENT');
			},
			runHelperFn: cmd => (cmd === '/bin/get-key.sh' ? 'sk-ant-api03-x' : null),
		});
		expect(result).toEqual({
			source: 'settings:apiKeyHelper',
			kind: 'apiKey',
			value: 'sk-ant-api03-x',
		});
	});

	it('classifies helper output as oauthToken when prefix is sk-ant-oat', () => {
		const settingsJson = JSON.stringify({apiKeyHelper: '/bin/h.sh'});
		const result = lookupCredential({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			readFileFn: p =>
				p === '/home/user/.claude/settings.json'
					? settingsJson
					: (() => {
							throw new Error('ENOENT');
						})(),
			runHelperFn: () => 'sk-ant-oat01-token',
		});
		expect(result?.kind).toBe('oauthToken');
	});

	it('prefers ANTHROPIC_API_KEY env over helper output of any kind', () => {
		const settingsJson = JSON.stringify({apiKeyHelper: '/bin/h.sh'});
		const result = lookupCredential({
			env: {ANTHROPIC_API_KEY: 'sk-ant-real'},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			readFileFn: p =>
				p === '/home/user/.claude/settings.json'
					? settingsJson
					: (() => {
							throw new Error('ENOENT');
						})(),
			runHelperFn: () => 'sk-ant-oat01-from-helper',
		});
		expect(result?.source).toBe('env:ANTHROPIC_API_KEY');
	});

	it('extracts claudeAiOauth.accessToken from macOS keychain entry', () => {
		const keychainPayload = JSON.stringify({
			claudeAiOauth: {accessToken: 'sk-ant-oat01-from-keychain'},
		});
		const result = lookupCredential({
			env: {},
			platform: 'darwin',
			readFileFn: () => {
				throw new Error('ENOENT');
			},
			runHelperFn: () => null,
			keychainLookupFn: service =>
				service === 'Claude Code-credentials' ? keychainPayload : null,
		});
		expect(result).toEqual({
			source: 'keychain:Claude Code-credentials',
			kind: 'oauthToken',
			value: 'sk-ant-oat01-from-keychain',
		});
	});

	it('reads ~/.claude/.credentials.json on non-darwin platforms', () => {
		const credentialsJson = JSON.stringify({
			claudeAiOauth: {accessToken: 'sk-ant-oat01-from-file'},
		});
		const result = lookupCredential({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			readFileFn: p => {
				if (p === '/home/user/.claude/.credentials.json')
					return credentialsJson;
				throw new Error('ENOENT');
			},
		});
		expect(result).toEqual({
			source: 'file:.credentials.json',
			kind: 'oauthToken',
			value: 'sk-ant-oat01-from-file',
		});
	});

	it('respects $CLAUDE_CONFIG_DIR for credentials file lookup', () => {
		const credentialsJson = JSON.stringify({accessToken: 'flat-token'});
		const result = lookupCredential({
			env: {CLAUDE_CONFIG_DIR: '/etc/claude'},
			platform: 'linux',
			homeDir: '/home/user',
			readFileFn: p => {
				if (p === '/etc/claude/.credentials.json') return credentialsJson;
				throw new Error('ENOENT');
			},
		});
		expect(result?.source).toBe('file:.credentials.json');
		expect(result?.value).toBe('flat-token');
	});

	it('does not consult keychain on non-darwin platforms', () => {
		const lookup = vi.fn(() => 'something');
		const result = lookupCredential({
			env: {},
			platform: 'linux',
			keychainLookupFn: lookup,
			readFileFn: () => {
				throw new Error('ENOENT');
			},
		});
		expect(result).toBeNull();
		expect(lookup).not.toHaveBeenCalled();
	});

	it('returns null when no credential is found anywhere', () => {
		const result = lookupCredential({
			env: {},
			platform: 'darwin',
			keychainLookupFn: () => null,
		});
		expect(result).toBeNull();
	});
});

describe('lookupAllCredentials', () => {
	const isolated = () => ({
		readFileFn: () => {
			throw new Error('ENOENT');
		},
		runHelperFn: () => null,
		keychainLookupFn: () => null,
	});

	it('returns every distinct credential found, not just the first', () => {
		const all = lookupAllCredentials({
			...isolated(),
			env: {
				ANTHROPIC_API_KEY: 'sk-ant-real',
				ANTHROPIC_AUTH_TOKEN: 'bearer-xyz',
			},
			platform: 'linux',
		});
		expect(all).toEqual([
			{source: 'env:ANTHROPIC_API_KEY', kind: 'apiKey', value: 'sk-ant-real'},
			{
				source: 'env:ANTHROPIC_AUTH_TOKEN',
				kind: 'authToken',
				value: 'bearer-xyz',
			},
		]);
	});

	it('honors apiKeyOverride from the --api-key flag with highest priority', () => {
		const all = lookupAllCredentials({
			...isolated(),
			env: {ANTHROPIC_API_KEY: 'sk-ant-from-env'},
			platform: 'linux',
			apiKeyOverride: 'sk-ant-from-flag',
		});
		expect(all[0]).toEqual({
			source: 'flag:--api-key',
			kind: 'apiKey',
			value: 'sk-ant-from-flag',
		});
		expect(all).toHaveLength(2);
	});

	it('reads ANTHROPIC_API_KEY from the macOS keychain (separate service from oauth credentials)', () => {
		const all = lookupAllCredentials({
			env: {},
			platform: 'darwin',
			readFileFn: () => {
				throw new Error('ENOENT');
			},
			runHelperFn: () => null,
			keychainLookupFn: service =>
				service === 'ANTHROPIC_API_KEY' ? 'sk-ant-api03-from-keychain' : null,
		});
		expect(all).toContainEqual({
			source: 'keychain:ANTHROPIC_API_KEY',
			kind: 'apiKey',
			value: 'sk-ant-api03-from-keychain',
		});
	});

	it('extracts ANTHROPIC_API_KEY from <cwd>/.env via dotenv parsing', () => {
		const all = lookupAllCredentials({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			runHelperFn: () => null,
			readFileFn: p => {
				if (p === '/repo/.env')
					return [
						'# comment',
						'OTHER=value',
						'ANTHROPIC_API_KEY="sk-ant-api03-from-dotenv"',
					].join('\n');
				throw new Error('ENOENT');
			},
		});
		expect(all).toContainEqual({
			source: 'dotenv:.env',
			kind: 'apiKey',
			value: 'sk-ant-api03-from-dotenv',
		});
	});

	it('parses both `export FOO=bar` and `FOO=bar` dotenv lines', () => {
		const all = lookupAllCredentials({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			runHelperFn: () => null,
			readFileFn: p => {
				if (p === '/repo/.env.local')
					return 'export ANTHROPIC_API_KEY=sk-ant-real';
				throw new Error('ENOENT');
			},
		});
		expect(all).toContainEqual({
			source: 'dotenv:.env.local',
			kind: 'apiKey',
			value: 'sk-ant-real',
		});
	});

	it('classifies helper output by token prefix and adds it as a separate credential', () => {
		const settingsJson = JSON.stringify({apiKeyHelper: '/bin/h.sh'});
		const all = lookupAllCredentials({
			env: {ANTHROPIC_API_KEY: 'sk-ant-api03-from-env'},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			readFileFn: p =>
				p === '/home/user/.claude/settings.json'
					? settingsJson
					: (() => {
							throw new Error('ENOENT');
						})(),
			runHelperFn: () => 'sk-ant-oat01-from-helper',
		});
		// Both env API key and helper-OAuth show up so each can be probed.
		expect(all.find(c => c.source === 'env:ANTHROPIC_API_KEY')).toBeDefined();
		expect(all.find(c => c.source === 'settings:apiKeyHelper')).toEqual({
			source: 'settings:apiKeyHelper',
			kind: 'oauthToken',
			value: 'sk-ant-oat01-from-helper',
		});
	});

	it('discovers ANTHROPIC_API_KEY from a settings.json env block (per settings.md)', () => {
		const settingsJson = JSON.stringify({
			env: {ANTHROPIC_API_KEY: 'sk-ant-api03-from-settings-env'},
		});
		const all = lookupAllCredentials({
			env: {},
			platform: 'linux',
			homeDir: '/home/user',
			cwd: '/repo',
			readFileFn: p =>
				p === '/home/user/.claude/settings.json'
					? settingsJson
					: (() => {
							throw new Error('ENOENT');
						})(),
			runHelperFn: () => null,
		});
		expect(all).toContainEqual({
			source: 'settings:env:ANTHROPIC_API_KEY',
			kind: 'apiKey',
			value: 'sk-ant-api03-from-settings-env',
		});
	});

	it('discovers credentials injected by launchctl setenv on macOS', () => {
		const all = lookupAllCredentials({
			env: {},
			platform: 'darwin',
			homeDir: '/Users/u',
			cwd: '/repo',
			keychainLookupFn: () => null,
			readFileFn: () => {
				throw new Error('ENOENT');
			},
			runHelperFn: () => null,
			launchctlGetenvFn: name =>
				name === 'ANTHROPIC_API_KEY' ? 'sk-ant-api03-from-launchctl' : null,
			readManagedPlistFn: () => null,
		});
		expect(all).toContainEqual({
			source: 'launchctl:ANTHROPIC_API_KEY',
			kind: 'apiKey',
			value: 'sk-ant-api03-from-launchctl',
		});
	});

	it('discovers an API key from the macOS managed-preferences plist', () => {
		// Realistic key shape — extractApiKeyFromParsed requires ≥40 trailing chars.
		const apiKey = `sk-ant-api03-${'A'.repeat(80)}`;
		const plistJson = JSON.stringify({
			env: {ANTHROPIC_API_KEY: apiKey},
		});
		const all = lookupAllCredentials({
			env: {},
			platform: 'darwin',
			homeDir: '/Users/u',
			cwd: '/repo',
			keychainLookupFn: () => null,
			readFileFn: () => {
				throw new Error('ENOENT');
			},
			runHelperFn: () => null,
			launchctlGetenvFn: () => null,
			readManagedPlistFn: () => plistJson,
		});
		expect(all).toContainEqual({
			source: 'managed-plist:com.anthropic.claudecode',
			kind: 'apiKey',
			value: apiKey,
		});
	});

	it('deduplicates identical (source, value) entries', () => {
		const all = lookupAllCredentials({
			env: {
				ANTHROPIC_API_KEY: 'sk-ant-real',
				ANTHROPIC_AUTH_TOKEN: 'sk-ant-real', // contrived: same value
			},
			platform: 'linux',
			runHelperFn: () => null,
			readFileFn: () => {
				throw new Error('ENOENT');
			},
		});
		// Both entries kept because they have different sources, but each unique.
		const keys = new Set(all.map(c => `${c.source}|${c.value}`));
		expect(keys.size).toBe(all.length);
	});
});

describe('buildApiKeyHelperSettings', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it('writes a settings file whose apiKeyHelper printf-prints the literal credential', () => {
		const result = buildApiKeyHelperSettings('sk-ant-api03-secret', tempDir);
		expect(fs.existsSync(result.settingsPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
		expect(parsed).toEqual({
			apiKeyHelper: "printf %s 'sk-ant-api03-secret'",
		});
		result.cleanup();
		expect(fs.existsSync(result.settingsPath)).toBe(false);
	});

	it('shell-quotes single quotes in the credential value', () => {
		const result = buildApiKeyHelperSettings("weird'key", tempDir);
		const parsed = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
		// Standard sh-escape: close ', emit \', reopen '. Result: 'weird'\''key'
		expect(parsed.apiKeyHelper).toBe(`printf %s 'weird'\\''key'`);
		result.cleanup();
	});
});

describe('buildProbeConfigs', () => {
	it('always includes Athena baseline probes A1 (strict-isolation) and A2 (default-context)', () => {
		const probes = buildProbeConfigs({strictSettingsPath: '/tmp/strict.json'});
		const athenaIds = probes.filter(p => p.group === 'athena').map(p => p.id);
		expect(athenaIds).toEqual(['A1', 'A2']);
		const a1 = probes.find(p => p.id === 'A1')!;
		expect(a1.args).toContain('stream-json');
		expect(a1.args).toContain('/tmp/strict.json');
		expect(a1.args).not.toContain('--bare');
	});

	it('produces 4 inherited-auth probes covering the {bare, sources} 2x2 matrix', () => {
		const probes = buildProbeConfigs({strictSettingsPath: '/tmp/s.json'});
		const inherited = probes.filter(p => p.group === 'inherited');
		expect(inherited.map(p => p.id)).toEqual(['B-be', 'B-bE', 'B-Be', 'B-BE']);
		// B-be: no bare, default sources
		expect(inherited[0]!.args).not.toContain('--bare');
		expect(inherited[0]!.args).not.toContain('--setting-sources');
		// B-BE: bare + empty sources
		expect(inherited[3]!.args).toContain('--bare');
		const idx = inherited[3]!.args.indexOf('--setting-sources');
		expect(inherited[3]!.args[idx + 1]).toBe('');
	});

	it('adds 4 credential probes per credential, injecting ANTHROPIC_API_KEY for apiKey kind', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			credentials: [
				{source: 'env:ANTHROPIC_API_KEY', kind: 'apiKey', value: 'sk-ant-real'},
			],
		});
		const credProbes = probes.filter(p => p.group === 'credential');
		expect(credProbes).toHaveLength(4);
		for (const probe of credProbes) {
			expect(probe.env?.ANTHROPIC_API_KEY).toBe('sk-ant-real');
			expect(probe.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(probe.id.startsWith('C1-')).toBe(true);
		}
	});

	it('does NOT inject OAuth tokens into env vars (per Anthropic auth docs)', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			credentials: [
				{
					source: 'keychain:Claude Code-credentials',
					kind: 'oauthToken',
					value: 'sk-ant-oat01-x',
				},
			],
		});
		const credProbes = probes.filter(p => p.group === 'credential');
		expect(credProbes).toHaveLength(4);
		for (const probe of credProbes) {
			expect(probe.env).toBeUndefined();
			expect(probe.credentialKind).toBe('oauthToken');
		}
	});

	it('emits separate C1/D1 and C2/D2 groups when two credentials are available', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			helperSettingsByCredential: new Map([
				['flag:--api-key|sk-ant-api03-key', '/tmp/h-key.json'],
				['keychain:Claude Code-credentials|sk-ant-oat01-x', '/tmp/h-oat.json'],
			]),
			credentials: [
				{source: 'flag:--api-key', kind: 'apiKey', value: 'sk-ant-api03-key'},
				{
					source: 'keychain:Claude Code-credentials',
					kind: 'oauthToken',
					value: 'sk-ant-oat01-x',
				},
			],
		});
		const c1 = probes.filter(
			p => p.group === 'credential' && p.id.startsWith('C1'),
		);
		const c2 = probes.filter(
			p => p.group === 'credential' && p.id.startsWith('C2'),
		);
		const d1 = probes.filter(
			p => p.group === 'helper' && p.id.startsWith('D1'),
		);
		const d2 = probes.filter(
			p => p.group === 'helper' && p.id.startsWith('D2'),
		);
		expect(c1).toHaveLength(4);
		expect(c2).toHaveLength(4);
		expect(d1).toHaveLength(4);
		expect(d2).toHaveLength(4);
		// API key probes use ANTHROPIC_API_KEY
		expect(c1[0]!.env?.ANTHROPIC_API_KEY).toBe('sk-ant-api03-key');
		// OAuth credentials cannot be env-injected
		expect(c2[0]!.env).toBeUndefined();
		expect(c2[0]!.credentialKind).toBe('oauthToken');
		// D1 references the API-key helper, D2 references the OAuth helper
		expect(d1[0]!.args).toContain('/tmp/h-key.json');
		expect(d2[0]!.args).toContain('/tmp/h-oat.json');
	});

	it('emits placeholder C and D groups (for skip reporting) when no credentials are available', () => {
		const probes = buildProbeConfigs({strictSettingsPath: '/tmp/s.json'});
		expect(probes.filter(p => p.group === 'credential')).toHaveLength(4);
		expect(probes.filter(p => p.group === 'helper')).toHaveLength(4);
		for (const probe of probes.filter(p => p.group === 'credential')) {
			expect(probe.env).toBeUndefined();
		}
	});

	it('probe IDs are unique across the matrix', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			helperSettingsByCredential: new Map([
				['env:ANTHROPIC_API_KEY|sk-ant-x', '/tmp/h.json'],
			]),
			credentials: [
				{source: 'env:ANTHROPIC_API_KEY', kind: 'apiKey', value: 'sk-ant-x'},
			],
		});
		const ids = probes.map(p => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('probeSkipReason', () => {
	const buildOpts = {strictSettingsPath: '/tmp/s.json'};

	it('returns null for athena and non-bare inherited probes (always runnable)', () => {
		const probes = buildProbeConfigs(buildOpts);
		const a1 = probes.find(p => p.id === 'A1')!;
		const bbe = probes.find(p => p.id === 'B-be')!;
		expect(probeSkipReason(a1, buildOpts)).toBeNull();
		expect(probeSkipReason(bbe, buildOpts)).toBeNull();
	});

	it('skips inherited --bare probes (no env credential injected, --bare bypasses OAuth)', () => {
		const probes = buildProbeConfigs(buildOpts);
		const bBe = probes.find(p => p.id === 'B-Be')!;
		const bBE = probes.find(p => p.id === 'B-BE')!;
		expect(probeSkipReason(bBe, buildOpts)).toMatch(/--bare skips OAuth/u);
		expect(probeSkipReason(bBE, buildOpts)).toMatch(/--bare skips OAuth/u);
	});

	it('returns the credentialMissingReason for credential probes when no credentials are resolved', () => {
		const opts = {
			...buildOpts,
			credentialMissingReason:
				'No credential resolved (tried env, helper, keychain)',
		};
		const probe = buildProbeConfigs(opts).find(p => p.group === 'credential')!;
		expect(probeSkipReason(probe, opts)).toBe(
			'No credential resolved (tried env, helper, keychain)',
		);
	});

	it('returns a helper-specific reason when helperSettingsByCredential is empty', () => {
		const opts = {
			strictSettingsPath: '/tmp/s.json',
			credentials: [
				{
					source: 'env:ANTHROPIC_API_KEY' as const,
					kind: 'apiKey' as const,
					value: 'sk-ant-x',
				},
			],
		};
		const probe = buildProbeConfigs(opts).find(p => p.group === 'helper')!;
		expect(probeSkipReason(probe, opts)).toBe(
			'helper settings file was not generated',
		);
	});

	it('skips credential probes for OAuth-kind credentials per Anthropic auth docs', () => {
		const opts = {
			strictSettingsPath: '/tmp/s.json',
			credentials: [
				{
					source: 'keychain:Claude Code-credentials' as const,
					kind: 'oauthToken' as const,
					value: 'sk-ant-oat01-x',
				},
			],
		};
		const probe = buildProbeConfigs(opts).find(p => p.group === 'credential')!;
		expect(probeSkipReason(probe, opts)).toMatch(/No API key available/u);
	});

	it('returns null for credential and helper probes when all inputs are present', () => {
		const opts = {
			strictSettingsPath: '/tmp/s.json',
			helperSettingsByCredential: new Map([
				['env:ANTHROPIC_API_KEY|sk-ant-x', '/tmp/h.json'],
			]),
			credentials: [
				{
					source: 'env:ANTHROPIC_API_KEY' as const,
					kind: 'apiKey' as const,
					value: 'sk-ant-x',
				},
			],
		};
		const probes = buildProbeConfigs(opts);
		for (const probe of probes) {
			// Inherited --bare probes are always skipped (structural impossibility).
			if (probe.group === 'inherited' && probe.args.includes('--bare')) {
				expect(probeSkipReason(probe, opts)).toMatch(/--bare skips OAuth/u);
				continue;
			}
			expect(probeSkipReason(probe, opts)).toBeNull();
		}
	});
});

describe('formatProbeCommand', () => {
	it('renders the full claude invocation with prompt elided and credentials masked', () => {
		const probe = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			credentials: [
				{
					source: 'env:ANTHROPIC_API_KEY',
					kind: 'apiKey',
					value: 'sk-ant-api03-1234567890abcdef',
				},
			],
		}).find(p => p.id === 'C1-Be')!;
		const cmd = formatProbeCommand(probe, '/usr/local/bin/claude');
		expect(cmd).toContain('ANTHROPIC_API_KEY=');
		expect(cmd).not.toContain('sk-ant-api03-1234567890abcdef');
		expect(cmd).toContain('--bare');
		expect(cmd).toContain('<prompt>');
		// Binary is rendered as basename, not the full path.
		expect(cmd).toContain(' claude ');
		expect(cmd).not.toContain('/usr/local/bin/claude');
	});

	it('substitutes alias map entries with $aliasName', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/very-long-path/hooks.json',
		});
		const a1 = probes.find(p => p.id === 'A1')!;
		const aliases = new Map([['hooks', '/tmp/very-long-path/hooks.json']]);
		const cmd = formatProbeCommand(a1, '/usr/bin/claude', aliases);
		expect(cmd).toContain('$hooks');
		expect(cmd).not.toContain('/tmp/very-long-path/hooks.json');
	});

	it('shell-quotes paths with spaces or unusual characters', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/has space.json',
		});
		const a1 = probes.find(p => p.id === 'A1')!;
		const cmd = formatProbeCommand(a1, '/usr/bin/claude');
		expect(cmd).toContain(`'/tmp/has space.json'`);
	});
});

describe('classifyFailure', () => {
	const baseResult: ProbeResult = {
		id: 'X',
		group: 'inherited',
		groupLabel: 'g',
		label: 'l',
		command: 'claude …',
		status: 'fail',
		exitCode: 1,
		durationMs: 100,
		stdoutTail: '',
		stderrTail: '',
	};

	it('returns null for passing probes', () => {
		expect(classifyFailure({...baseResult, status: 'pass'})).toBeNull();
	});

	it('detects "Not logged in" → "No auth available"', () => {
		const f = classifyFailure({
			...baseResult,
			stdoutTail: 'Not logged in · Please run /login',
		})!;
		expect(f.title).toBe('No auth available');
		expect(f.hint).toMatch(/--bare skips/u);
	});

	it('detects "OAuth authentication is currently not supported" → "OAuth token rejected"', () => {
		const f = classifyFailure({
			...baseResult,
			stderrTail:
				'Failed to authenticate. API Error: 401 {"error":{"message":"OAuth authentication is currently not supported."}}',
		})!;
		expect(f.title).toBe('OAuth token rejected');
		expect(f.hint).toMatch(/Console API key/u);
	});

	it('classifies generic 401 as authentication failed', () => {
		const f = classifyFailure({
			...baseResult,
			stderrTail: 'API Error: 401 unauthorized',
		})!;
		expect(f.title).toBe('Authentication failed (401)');
	});

	it('classifies 400 as bad request with format hint', () => {
		const f = classifyFailure({
			...baseResult,
			stdoutTail: 'API Error: 400 status code (no body)',
		})!;
		expect(f.title).toBe('Bad request (400)');
		expect(f.hint).toMatch(/format/u);
	});

	it('detects timeout', () => {
		const f = classifyFailure({
			...baseResult,
			stderrTail: 'Probe timed out after 30000ms',
		})!;
		expect(f.title).toBe('Probe timed out');
	});

	it('falls back to the last meaningful line for unknown failures', () => {
		const f = classifyFailure({
			...baseResult,
			stderrTail: 'something unexpected happened',
		})!;
		expect(f.title).toBe('something unexpected happened');
		expect(f.hint).toBeUndefined();
	});

	it('skips noisy "Command failed:" lines when picking the diagnostic line', () => {
		const f = classifyFailure({
			...baseResult,
			stderrTail:
				'Command failed: claude --bare ...\nNot logged in · Please run /login',
		})!;
		expect(f.title).toBe('No auth available');
	});
});

describe('makeSkippedProbe', () => {
	const baseProbe = {
		id: 'X1',
		group: 'credential' as const,
		groupLabel: 'Credential test',
		label: 'bare + key',
		args: [],
	};

	it('builds a skip result with the given reason', () => {
		const result = makeSkippedProbe(baseProbe, 'no key found');
		expect(result.status).toBe('skip');
		expect(result.skipReason).toBe('no key found');
		expect(result.exitCode).toBeNull();
		expect(result.durationMs).toBe(0);
	});

	it('supports n/a status for non-anthropic providers', () => {
		const result = makeSkippedProbe(baseProbe, 'bedrock provider', 'na');
		expect(result.status).toBe('na');
	});
});

describe('DOCTOR_EXPECTED sentinel', () => {
	it('is the string the prompt asks Claude to echo', () => {
		expect(DOCTOR_EXPECTED).toBe('ATHENA_DOCTOR_OK');
	});
});
