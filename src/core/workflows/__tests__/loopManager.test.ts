import {describe, it, expect, vi, beforeEach} from 'vitest';

const files: Record<string, string> = {};
const dirs: Set<string> = new Set();

vi.mock('node:fs', () => ({
	default: {
		existsSync: (p: string) => p in files || dirs.has(p),
		readFileSync: (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
	},
}));

const {createLoopManager, buildContinuePrompt, DEFAULT_TRACKER_PATH} =
	await import('../loopManager');

beforeEach(() => {
	for (const key of Object.keys(files)) delete files[key];
	dirs.clear();
});

const DEFAULT_CONFIG = {
	enabled: true,
	completionMarker: '<!-- E2E_COMPLETE -->',
	maxIterations: 5,
	trackerPath: 'e2e-tracker.md',
};

describe('createLoopManager', () => {
	describe('getState', () => {
		it('returns active state with defaults when tracker does not exist', () => {
			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			const state = mgr.getState();

			expect(state.active).toBe(true);
			expect(state.iteration).toBe(0);
			expect(state.maxIterations).toBe(5);
			expect(state.completed).toBe(false);
			expect(state.blocked).toBe(false);
			expect(state.reachedLimit).toBe(false);
		});

		it('detects completion marker in tracker content', () => {
			files['/project/e2e-tracker.md'] = [
				'# E2E Test Tracker',
				'## Steps',
				'| 1 | Analyze | done |',
				'<!-- E2E_COMPLETE -->',
			].join('\n');

			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			const state = mgr.getState();

			expect(state.completed).toBe(true);
		});

		it('ignores completion marker text unless it is the last non-empty line', () => {
			files['/project/e2e-tracker.md'] = [
				'# E2E Test Tracker',
				'Do not write <!-- E2E_COMPLETE --> until verification passes.',
				'## Steps',
				'- still running',
			].join('\n');

			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			const state = mgr.getState();

			expect(state.completed).toBe(false);
		});

		it('uses default WORKFLOW_COMPLETE marker when none specified', () => {
			files['/project/tracker.md'] = '<!-- WORKFLOW_COMPLETE -->';
			const mgr = createLoopManager('/project/tracker.md', {
				enabled: true,
				maxIterations: 5,
			});
			expect(mgr.getState().completed).toBe(true);
		});

		it('uses default WORKFLOW_BLOCKED marker when none specified', () => {
			files['/project/tracker.md'] =
				'<!-- WORKFLOW_BLOCKED: browser unavailable -->';
			const mgr = createLoopManager('/project/tracker.md', {
				enabled: true,
				maxIterations: 5,
			});
			const state = mgr.getState();
			expect(state.blocked).toBe(true);
			expect(state.blockedReason).toBe('browser unavailable');
		});

		it('detects blocked marker with reason extraction', () => {
			files['/project/e2e-tracker.md'] = [
				'# E2E Test Tracker',
				'<!-- E2E_BLOCKED: No Playwright config found -->',
			].join('\n');

			const config = {
				...DEFAULT_CONFIG,
				blockedMarker: '<!-- E2E_BLOCKED',
			};
			const mgr = createLoopManager('/project/e2e-tracker.md', config);
			const state = mgr.getState();

			expect(state.blocked).toBe(true);
			expect(state.blockedReason).toBe('No Playwright config found');
		});

		it('accepts blocked marker without a reason on the last line', () => {
			files['/project/e2e-tracker.md'] = [
				'# E2E Test Tracker',
				'## Notes',
				'Waiting on external access.',
				'<!-- E2E_BLOCKED -->',
			].join('\n');

			const config = {
				...DEFAULT_CONFIG,
				blockedMarker: '<!-- E2E_BLOCKED',
			};
			const mgr = createLoopManager('/project/e2e-tracker.md', config);
			const state = mgr.getState();

			expect(state.blocked).toBe(true);
			expect(state.blockedReason).toBeUndefined();
		});

		it('ignores blocked marker text unless it is the last non-empty line', () => {
			files['/project/e2e-tracker.md'] = [
				'# E2E Test Tracker',
				'Example marker: <!-- E2E_BLOCKED: placeholder -->',
				'## Steps',
				'- still running',
			].join('\n');

			const config = {
				...DEFAULT_CONFIG,
				blockedMarker: '<!-- E2E_BLOCKED',
			};
			const mgr = createLoopManager('/project/e2e-tracker.md', config);
			const state = mgr.getState();

			expect(state.blocked).toBe(false);
			expect(state.blockedReason).toBeUndefined();
		});

		it('detects reached iteration limit', () => {
			const mgr = createLoopManager('/project/e2e-tracker.md', {
				...DEFAULT_CONFIG,
				maxIterations: 3,
			});
			mgr.incrementIteration();
			mgr.incrementIteration();
			mgr.incrementIteration();

			expect(mgr.getState().reachedLimit).toBe(true);
		});

		it('fails open when tracker is unreadable', () => {
			// File doesn't exist — getState returns empty content, not an error
			const mgr = createLoopManager('/nonexistent/tracker.md', DEFAULT_CONFIG);
			const state = mgr.getState();
			expect(state.active).toBe(true);
			expect(state.completed).toBe(false);
		});
	});

	describe('incrementIteration', () => {
		it('increments in-memory counter', () => {
			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			expect(mgr.getState().iteration).toBe(0);

			mgr.incrementIteration();
			expect(mgr.getState().iteration).toBe(1);

			mgr.incrementIteration();
			expect(mgr.getState().iteration).toBe(2);
		});
	});

	describe('deactivate', () => {
		it('sets active to false in memory', () => {
			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			expect(mgr.getState().active).toBe(true);

			mgr.deactivate();
			expect(mgr.getState().active).toBe(false);
		});
	});

	describe('trackerPath', () => {
		it('exposes the tracker path', () => {
			const mgr = createLoopManager('/project/e2e-tracker.md', DEFAULT_CONFIG);
			expect(mgr.trackerPath).toBe('/project/e2e-tracker.md');
		});
	});
});

describe('buildContinuePrompt', () => {
	it('uses default template with trackerPath substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			trackerPath: 'e2e-tracker.md',
		});
		expect(result).toContain('e2e-tracker.md');
		expect(result).toContain('Continue');
	});

	it('uses custom continuePrompt with {trackerPath} substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			trackerPath: 'my-tracker.md',
			continuePrompt: 'Read {trackerPath} and continue.',
		});
		expect(result).toBe('Read my-tracker.md and continue.');
	});

	it('falls back to default tracker path when trackerPath not specified', () => {
		const result = buildContinuePrompt({
			enabled: true,
			maxIterations: 5,
		});
		expect(result).toContain(DEFAULT_TRACKER_PATH);
	});
});
