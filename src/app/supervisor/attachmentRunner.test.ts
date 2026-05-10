import {EventEmitter} from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import {createAttachmentRunner} from './attachmentRunner';

class FakeChild extends EventEmitter {
	readonly pid = 4242;
	killed = false;
	killCalls: Array<NodeJS.Signals | undefined> = [];
	kill(signal?: NodeJS.Signals): boolean {
		this.killCalls.push(signal);
		this.killed = true;
		return true;
	}
	emitExit(code: number, signal: NodeJS.Signals | null = null): void {
		this.emit('exit', code, signal);
	}
}

describe('AttachmentRunner', () => {
	it('exposes attachmentId and runnerId from construction', () => {
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild: () => new FakeChild(),
		});
		expect(runner.attachmentId).toBe('a1');
		expect(runner.runnerId).toBe('r1');
	});

	it('start() spawns the harness child with --attachment-id and --runner', async () => {
		const spawnChild = vi.fn(() => new FakeChild());
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild,
		});
		await runner.start();
		expect(spawnChild).toHaveBeenCalledTimes(1);
		const args = spawnChild.mock.calls[0]?.[0] ?? [];
		expect(args).toContain('--attachment-id');
		expect(args).toContain('a1');
		expect(args).toContain('--runner');
		expect(args).toContain('r1');
	});

	it('start() is idempotent — second call does not spawn another child', async () => {
		const spawnChild = vi.fn(() => new FakeChild());
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild,
		});
		await runner.start();
		await runner.start();
		expect(spawnChild).toHaveBeenCalledTimes(1);
	});

	it('stop("shutdown") sends SIGTERM to the child and resolves once it exits', async () => {
		const child = new FakeChild();
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild: () => child,
		});
		await runner.start();
		const stopPromise = runner.stop('shutdown');
		expect(child.killCalls).toEqual(['SIGTERM']);
		child.emitExit(0);
		await stopPromise;
	});

	it('onChildExit fires with the exit code and signal when the child exits', async () => {
		const child = new FakeChild();
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild: () => child,
		});
		const onExit = vi.fn();
		runner.onChildExit(onExit);
		await runner.start();
		child.emitExit(7, 'SIGTERM');
		expect(onExit).toHaveBeenCalledWith({code: 7, signal: 'SIGTERM'});
	});

	it('stop() before start() is a no-op', async () => {
		const spawnChild = vi.fn(() => new FakeChild());
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild,
		});
		await runner.stop('shutdown');
		expect(spawnChild).not.toHaveBeenCalled();
	});

	it('appends extraArgs after the attachment/runner flags', async () => {
		const spawnChild = vi.fn(() => new FakeChild());
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild,
			extraArgs: ['--project-dir', '/tmp/repo', '--verbose'],
		});
		await runner.start();
		const args = spawnChild.mock.calls[0]?.[0] ?? [];
		expect(args).toEqual([
			'--attachment-id',
			'a1',
			'--runner',
			'r1',
			'--project-dir',
			'/tmp/repo',
			'--verbose',
		]);
	});

	it('start() after a previous child exited spawns a fresh child', async () => {
		const children: FakeChild[] = [];
		const runner = createAttachmentRunner({
			attachmentId: 'a1',
			runnerId: 'r1',
			spawnChild: () => {
				const c = new FakeChild();
				children.push(c);
				return c;
			},
		});
		await runner.start();
		children[0]?.emitExit(1);
		await runner.start();
		expect(children).toHaveLength(2);
	});
});
