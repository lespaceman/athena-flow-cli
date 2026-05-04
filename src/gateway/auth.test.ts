import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	loadOrCreateToken,
	requireTokenForBind,
	rotateGatewayToken,
} from './auth';
import type {GatewayListenSpec} from './paths';

const createdTmpRoots: string[] = [];

function tmpTokenPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-token-'));
	createdTmpRoots.push(dir);
	return path.join(dir, 'gateway', 'token');
}

afterEach(() => {
	for (const dir of createdTmpRoots.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('requireTokenForBind', () => {
	it('allows UDS without a token', () => {
		const spec: GatewayListenSpec = {kind: 'uds', socketPath: '/tmp/gw.sock'};

		expect(() => requireTokenForBind(spec, '')).not.toThrow();
	});

	it('allows loopback TCP without insecure flag', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '127.0.0.1',
			port: 18789,
			insecure: false,
		};

		expect(() => requireTokenForBind(spec, 'secret-token-1234')).not.toThrow();
	});

	it('refuses non-loopback TCP without token', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '0.0.0.0',
			port: 18789,
			insecure: true,
		};

		expect(() => requireTokenForBind(spec, '')).toThrow(/without token/);
	});

	it('refuses non-loopback plain WS without --insecure', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '0.0.0.0',
			port: 18789,
			insecure: false,
		};

		expect(() => requireTokenForBind(spec, 'secret-token-1234')).toThrow(
			/--insecure/,
		);
	});

	it('allows non-loopback bind with TLS configured even without --insecure', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '0.0.0.0',
			port: 18789,
			insecure: false,
			tls: {certPath: '/etc/ssl/gw.crt', keyPath: '/etc/ssl/gw.key'},
		};

		expect(() => requireTokenForBind(spec, 'secret-token-1234')).not.toThrow();
	});
});

describe('rotateGatewayToken', () => {
	it('replaces an existing token with a new value at mode 0600', () => {
		const tokenPath = tmpTokenPath();
		const original = loadOrCreateToken(tokenPath);
		expect(original.length).toBeGreaterThanOrEqual(16);

		const rotated = rotateGatewayToken(tokenPath);
		expect(rotated).not.toEqual(original);
		expect(rotated.length).toBeGreaterThanOrEqual(16);
		expect(fs.readFileSync(tokenPath, 'utf-8').trim()).toEqual(rotated);

		if (process.platform !== 'win32') {
			const mode = fs.statSync(tokenPath).mode & 0o777;
			expect(mode).toBe(0o600);
			const dirMode = fs.statSync(path.dirname(tokenPath)).mode & 0o777;
			expect(dirMode).toBe(0o700);
		}
	});

	it('creates the directory and token when neither exists yet', () => {
		const tokenPath = tmpTokenPath();
		const rotated = rotateGatewayToken(tokenPath);
		expect(fs.existsSync(tokenPath)).toBe(true);
		expect(fs.readFileSync(tokenPath, 'utf-8').trim()).toEqual(rotated);
	});

	it('a daemon-style reload after rotation rejects the previous token', () => {
		const tokenPath = tmpTokenPath();
		const oldToken = loadOrCreateToken(tokenPath);
		const newToken = rotateGatewayToken(tokenPath);
		const reloaded = loadOrCreateToken(tokenPath);
		expect(reloaded).toEqual(newToken);
		expect(reloaded).not.toEqual(oldToken);
	});
});
