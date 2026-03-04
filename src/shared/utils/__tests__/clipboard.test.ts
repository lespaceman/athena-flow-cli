import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {execSync} from 'node:child_process';

vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe('copyToClipboard', () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	const originalPlatform = process.platform;
	const originalEnv = {...process.env};

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		vi.resetModules();
	});
	afterEach(() => {
		writeSpy.mockRestore();
		mockedExecSync.mockReset();
		process.env = {...originalEnv};
		Object.defineProperty(process, 'platform', {value: originalPlatform});
	});

	it('uses xclip on linux with X11', async () => {
		Object.defineProperty(process, 'platform', {value: 'linux'});
		process.env['XDG_SESSION_TYPE'] = 'x11';
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello world');
		expect(mockedExecSync).toHaveBeenCalledWith(
			'xclip -selection clipboard',
			expect.objectContaining({input: 'hello world'}),
		);
	});

	it('uses wl-copy on linux with wayland', async () => {
		Object.defineProperty(process, 'platform', {value: 'linux'});
		process.env['XDG_SESSION_TYPE'] = 'wayland';
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello world');
		expect(mockedExecSync).toHaveBeenCalledWith(
			'wl-copy',
			expect.objectContaining({input: 'hello world'}),
		);
	});

	it('uses pbcopy on darwin', async () => {
		Object.defineProperty(process, 'platform', {value: 'darwin'});
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello world');
		expect(mockedExecSync).toHaveBeenCalledWith(
			'pbcopy',
			expect.objectContaining({input: 'hello world'}),
		);
	});

	it('falls back to OSC 52 when CLI tool fails', async () => {
		Object.defineProperty(process, 'platform', {value: 'linux'});
		process.env['XDG_SESSION_TYPE'] = 'x11';
		mockedExecSync.mockImplementation(() => {
			throw new Error('xclip not found');
		});
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello world');
		const expected = Buffer.from('hello world').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('falls back to OSC 52 on unknown platform', async () => {
		Object.defineProperty(process, 'platform', {value: 'freebsd'});
		delete process.env['XDG_SESSION_TYPE'];
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello world');
		const expected = Buffer.from('hello world').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles multi-line content', async () => {
		Object.defineProperty(process, 'platform', {value: 'darwin'});
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('line1\nline2\nline3');
		expect(mockedExecSync).toHaveBeenCalledWith(
			'pbcopy',
			expect.objectContaining({input: 'line1\nline2\nline3'}),
		);
	});

	it('handles unicode content', async () => {
		Object.defineProperty(process, 'platform', {value: 'darwin'});
		const {copyToClipboard} = await import('../clipboard');
		copyToClipboard('hello 🌍');
		expect(mockedExecSync).toHaveBeenCalledWith(
			'pbcopy',
			expect.objectContaining({input: 'hello 🌍'}),
		);
	});
});
