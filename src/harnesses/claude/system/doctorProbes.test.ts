import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildApiKeyHelperSettings,
	buildProbeConfigs,
	DOCTOR_EXPECTED,
	lookupAnthropicApiKey,
	lookupCredential,
	makeSkippedProbe,
	probeSkipReason,
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

	it('skips helper when ANTHROPIC_API_KEY env wins precedence', () => {
		const settingsJson = JSON.stringify({apiKeyHelper: '/bin/h.sh'});
		const helperRan = vi.fn(() => 'should-not-be-used');
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
			runHelperFn: helperRan,
		});
		expect(result?.source).toBe('env:ANTHROPIC_API_KEY');
		expect(helperRan).not.toHaveBeenCalled();
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

describe('lookupAnthropicApiKey (legacy alias)', () => {
	it('delegates to lookupCredential', () => {
		const result = lookupAnthropicApiKey({
			env: {ANTHROPIC_API_KEY: 'sk-ant-x'},
			platform: 'darwin',
		});
		expect(result?.source).toBe('env:ANTHROPIC_API_KEY');
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

	it('writes a settings file containing apiKeyHelper command', () => {
		const result = buildApiKeyHelperSettings('/usr/local/bin/athena', tempDir);
		expect(fs.existsSync(result.settingsPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
		expect(parsed).toEqual({
			apiKeyHelper: '/usr/local/bin/athena doctor --print-api-key',
		});
		result.cleanup();
		expect(fs.existsSync(result.settingsPath)).toBe(false);
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

	it('adds 4 credential probes when an API-key credential is provided', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			credential: {
				source: 'env:ANTHROPIC_API_KEY',
				kind: 'apiKey',
				value: 'sk-ant-real',
			},
		});
		const credProbes = probes.filter(p => p.group === 'credential');
		expect(credProbes).toHaveLength(4);
		for (const probe of credProbes) {
			expect(probe.env?.ANTHROPIC_API_KEY).toBe('sk-ant-real');
			expect(probe.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		}
	});

	it('routes OAuth tokens through ANTHROPIC_AUTH_TOKEN in credential probes', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			credential: {
				source: 'keychain:Claude Code-credentials',
				kind: 'oauthToken',
				value: 'sk-ant-oat01-x',
			},
		});
		const credProbes = probes.filter(p => p.group === 'credential');
		expect(credProbes).toHaveLength(4);
		for (const probe of credProbes) {
			expect(probe.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat01-x');
			expect(probe.env?.ANTHROPIC_API_KEY).toBeUndefined();
		}
	});

	it('adds 4 helper probes when both credential and helperSettingsPath are provided', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			helperSettingsPath: '/tmp/h.json',
			credential: {
				source: 'env:ANTHROPIC_API_KEY',
				kind: 'apiKey',
				value: 'sk-ant-real',
			},
		});
		const helperProbes = probes.filter(p => p.group === 'helper');
		expect(helperProbes).toHaveLength(4);
		for (const probe of helperProbes) {
			expect(probe.args).toContain('/tmp/h.json');
		}
	});

	it('still emits credential and helper probes when no credential is available (for skip reporting)', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			helperSettingsPath: '/tmp/h.json',
		});
		expect(probes.filter(p => p.group === 'credential')).toHaveLength(4);
		expect(probes.filter(p => p.group === 'helper')).toHaveLength(4);
		// But without a credential, no env var should be injected.
		for (const probe of probes.filter(p => p.group === 'credential')) {
			expect(probe.env).toBeUndefined();
		}
	});

	it('probe IDs are unique across the matrix', () => {
		const probes = buildProbeConfigs({
			strictSettingsPath: '/tmp/s.json',
			helperSettingsPath: '/tmp/h.json',
			credential: {
				source: 'env:ANTHROPIC_API_KEY',
				kind: 'apiKey',
				value: 'sk-ant-x',
			},
		});
		const ids = probes.map(p => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('probeSkipReason', () => {
	const buildOpts = {strictSettingsPath: '/tmp/s.json'};

	it('returns null for athena and inherited probes (always runnable)', () => {
		const probes = buildProbeConfigs(buildOpts);
		const a1 = probes.find(p => p.id === 'A1')!;
		const bbe = probes.find(p => p.id === 'B-be')!;
		expect(probeSkipReason(a1, buildOpts)).toBeNull();
		expect(probeSkipReason(bbe, buildOpts)).toBeNull();
	});

	it('returns the credentialMissingReason for credential probes when no credential is resolved', () => {
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

	it('returns a helper-specific reason when helperSettingsPath is missing', () => {
		const opts = {
			strictSettingsPath: '/tmp/s.json',
			credential: {
				source: 'env:ANTHROPIC_API_KEY' as const,
				kind: 'apiKey' as const,
				value: 'sk-ant-x',
			},
		};
		const probe = buildProbeConfigs(opts).find(p => p.group === 'helper')!;
		expect(probeSkipReason(probe, opts)).toBe(
			'helper settings file was not generated',
		);
	});

	it('returns null for credential and helper probes when all inputs are present', () => {
		const opts = {
			strictSettingsPath: '/tmp/s.json',
			helperSettingsPath: '/tmp/h.json',
			credential: {
				source: 'env:ANTHROPIC_API_KEY' as const,
				kind: 'apiKey' as const,
				value: 'sk-ant-x',
			},
		};
		const probes = buildProbeConfigs(opts);
		for (const probe of probes) {
			expect(probeSkipReason(probe, opts)).toBeNull();
		}
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
