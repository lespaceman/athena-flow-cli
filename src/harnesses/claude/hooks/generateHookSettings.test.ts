import {describe, it, expect, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	formatHookForwarderCommand,
	generateHookSettings,
	quoteShellArg,
} from './generateHookSettings';

describe('generateHookSettings', () => {
	const createdFiles: string[] = [];

	afterEach(() => {
		// Clean up any created files
		for (const file of createdFiles) {
			try {
				if (fs.existsSync(file)) {
					fs.unlinkSync(file);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
		createdFiles.length = 0;
	});

	it('should create a temporary settings file', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		expect(fs.existsSync(result.settingsPath)).toBe(true);
	});

	it('should create file in specified temp directory', () => {
		const tempDir = os.tmpdir();
		const result = generateHookSettings(tempDir);
		createdFiles.push(result.settingsPath);

		expect(result.settingsPath.startsWith(tempDir)).toBe(true);
	});

	it('should generate unique filenames with pid and timestamp', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const filename = path.basename(result.settingsPath);
		expect(filename).toMatch(/^athena-hooks-\d+-\d+\.json$/);
	});

	it('should include hooks for all event types', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const content = fs.readFileSync(result.settingsPath, 'utf8');
		const settings = JSON.parse(content);

		expect(settings.hooks).toBeDefined();
		// Tool events
		expect(settings.hooks.PreToolUse).toBeDefined();
		expect(settings.hooks.PostToolUse).toBeDefined();
		// Non-tool events
		expect(settings.hooks.Notification).toBeDefined();
		expect(settings.hooks.Stop).toBeDefined();
		expect(settings.hooks.SessionStart).toBeDefined();
		expect(settings.hooks.SessionEnd).toBeDefined();
	});

	it('should configure tool hooks with matcher and command', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const content = fs.readFileSync(result.settingsPath, 'utf8');
		const settings = JSON.parse(content);

		// Tool events have matcher + nested hooks array
		const preToolUseEntry = settings.hooks.PreToolUse[0];
		expect(preToolUseEntry.matcher).toBe('*');
		expect(preToolUseEntry.hooks).toBeDefined();
		expect(preToolUseEntry.hooks[0].type).toBe('command');
		expect(preToolUseEntry.hooks[0].command).toBeDefined();
	});

	it('should configure non-tool hooks without matcher', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const content = fs.readFileSync(result.settingsPath, 'utf8');
		const settings = JSON.parse(content);

		// Non-tool events have no matcher, just nested hooks array
		const notificationEntry = settings.hooks.Notification[0];
		expect(notificationEntry.matcher).toBeUndefined();
		expect(notificationEntry.hooks).toBeDefined();
		expect(notificationEntry.hooks[0].type).toBe('command');
		expect(notificationEntry.hooks[0].command).toBeDefined();
	});

	it('should provide cleanup function that removes the file', () => {
		const result = generateHookSettings();
		const filePath = result.settingsPath;

		// File should exist before cleanup
		expect(fs.existsSync(filePath)).toBe(true);

		// Call cleanup
		result.cleanup();

		// File should be removed after cleanup
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('should not throw when cleanup is called multiple times', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		// Multiple cleanups should not throw
		expect(() => {
			result.cleanup();
			result.cleanup();
		}).not.toThrow();
	});

	it('should not throw when cleanup is called on non-existent file', () => {
		const result = generateHookSettings();

		// Remove file manually first
		fs.unlinkSync(result.settingsPath);

		// Cleanup should not throw
		expect(() => result.cleanup()).not.toThrow();
	});

	it('should not set custom timeout (relies on Claude Code defaults)', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const content = fs.readFileSync(result.settingsPath, 'utf8');
		const settings = JSON.parse(content);

		// No custom timeouts — Claude Code default (600s) applies
		expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBeUndefined();
		expect(
			settings.hooks.PermissionRequest[0].hooks[0].timeout,
		).toBeUndefined();
		expect(settings.hooks.Stop[0].hooks[0].timeout).toBeUndefined();
	});

	it('should write valid JSON', () => {
		const result = generateHookSettings();
		createdFiles.push(result.settingsPath);

		const content = fs.readFileSync(result.settingsPath, 'utf8');

		// Should not throw when parsing
		expect(() => JSON.parse(content)).not.toThrow();
	});

	it('quotes shell arguments safely for paths with spaces and quotes', () => {
		expect(quoteShellArg("/tmp/athena dir/it's-here")).toBe(
			`'/tmp/athena dir/it'"'"'s-here'`,
		);
	});

	it('formats hook forwarder command with absolute quoted node and script paths', () => {
		expect(
			formatHookForwarderCommand(
				'/opt/homebrew/bin/node',
				"/Users/test/Athena Dev/dist/hook-forwarder.js",
			),
		).toBe(
			`'/opt/homebrew/bin/node' '/Users/test/Athena Dev/dist/hook-forwarder.js'`,
		);
	});
});
