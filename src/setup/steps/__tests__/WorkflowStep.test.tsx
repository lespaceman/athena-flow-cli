import React from 'react';
import {render} from 'ink-testing-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import WorkflowStep from '../WorkflowStep';

const installWorkflowMock = vi.fn(() => 'e2e-test-builder');
const listMarketplaceWorkflowsMock = vi.fn(() => [
	{
		name: 'e2e-test-builder',
		description: 'Playwright-based browser test generation',
		ref: 'e2e-test-builder@lespaceman/athena-workflow-marketplace',
		workflowPath: '/cache/workflows/e2e-test-builder/workflow.json',
	},
	{
		name: 'bug-triage',
		description: 'Automated bug classification',
		ref: 'bug-triage@lespaceman/athena-workflow-marketplace',
		workflowPath: '/cache/workflows/bug-triage/workflow.json',
	},
]);
const listMarketplaceWorkflowsFromRepoMock = vi.fn(() => [
	{
		name: 'local-workflow',
		description: 'Local workflow',
		ref: 'local-workflow@local/workflow-marketplace',
		workflowPath:
			'/tmp/workflow-marketplace/workflows/local-workflow/workflow.json',
	},
]);
const findMarketplaceRepoDirMock = vi.fn();
const resolveMarketplaceWorkflowMock = vi.fn(
	() => '/tmp/workflow-marketplace/workflows/local-workflow/workflow.json',
);
const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() =>
	JSON.stringify({
		name: 'local-workflow',
		description: 'Local workflow',
	}),
);
const readGlobalConfigMock = vi.fn(() => ({
	plugins: [],
	additionalDirectories: [],
}));
const resolveWorkflowMarketplaceSourceMock = vi.fn((source: string) => ({
	kind: 'remote' as const,
	slug: source,
	owner: 'lespaceman',
	repo: 'athena-workflow-marketplace',
}));

vi.mock('node:fs', () => ({
	default: {
		existsSync: (...args: unknown[]) => existsSyncMock(...args),
		readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
	},
}));

vi.mock('../../../infra/plugins/marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	findMarketplaceRepoDir: (...args: unknown[]) =>
		findMarketplaceRepoDirMock(...args),
	listMarketplaceWorkflows: (...args: unknown[]) =>
		listMarketplaceWorkflowsMock(...args),
	listMarketplaceWorkflowsFromRepo: (...args: unknown[]) =>
		listMarketplaceWorkflowsFromRepoMock(...args),
	resolveWorkflowMarketplaceSource: (...args: unknown[]) =>
		resolveWorkflowMarketplaceSourceMock(...args),
	resolveMarketplaceWorkflow: (...args: unknown[]) =>
		resolveMarketplaceWorkflowMock(...args),
}));

vi.mock('../../../core/workflows/index', () => ({
	installWorkflow: (...args: unknown[]) => installWorkflowMock(...args),
	resolveWorkflow: vi.fn(() => ({
		name: 'e2e-test-builder',
		plugins: ['e2e-test-builder@lespaceman/athena-workflow-marketplace'],
	})),
	installWorkflowPlugins: vi.fn(() => ['/resolved/plugin/dir']),
}));

vi.mock('../../../infra/plugins/config', () => ({
	readGlobalConfig: (...args: unknown[]) => readGlobalConfigMock(...args),
}));

describe('WorkflowStep', () => {
	beforeEach(() => {
		installWorkflowMock.mockClear();
		listMarketplaceWorkflowsMock.mockClear();
		listMarketplaceWorkflowsFromRepoMock.mockClear();
		findMarketplaceRepoDirMock.mockReset();
		findMarketplaceRepoDirMock.mockReturnValue(undefined);
		resolveWorkflowMarketplaceSourceMock.mockReset();
		resolveWorkflowMarketplaceSourceMock.mockImplementation(
			(source: string) => ({
				kind: 'remote' as const,
				slug: source,
				owner: 'lespaceman',
				repo: 'athena-workflow-marketplace',
			}),
		);
		resolveMarketplaceWorkflowMock.mockClear();
		existsSyncMock.mockReset();
		existsSyncMock.mockReturnValue(false);
		readFileSyncMock.mockClear();
		readGlobalConfigMock.mockReset();
		readGlobalConfigMock.mockReturnValue({
			plugins: [],
			additionalDirectories: [],
		});
		delete process.env.ATHENA_STARTER_WORKFLOW_SOURCE;
	});

	it('renders workflows discovered from the Athena marketplace', async () => {
		const {lastFrame} = render(
			<WorkflowStep onComplete={() => {}} onError={() => {}} />,
		);
		await new Promise(r => setTimeout(r, 50));
		const frame = lastFrame()!;
		expect(frame).toContain('Select a workflow to continue.');
		expect(frame).toContain('e2e-test-builder');
		expect(frame).toContain('bug-triage');
		expect(listMarketplaceWorkflowsMock).toHaveBeenCalledWith(
			'lespaceman',
			'athena-workflow-marketplace',
		);
	});

	it('uses the configured local marketplace source when present', async () => {
		readGlobalConfigMock.mockReturnValue({
			plugins: [],
			additionalDirectories: [],
			workflowMarketplaceSource: '/tmp/workflow-marketplace',
		});
		resolveWorkflowMarketplaceSourceMock.mockReturnValue({
			kind: 'local',
			path: '/tmp/workflow-marketplace',
			repoDir: '/tmp/workflow-marketplace',
		});

		render(<WorkflowStep onComplete={() => {}} onError={() => {}} />);
		await new Promise(r => setTimeout(r, 50));

		expect(listMarketplaceWorkflowsFromRepoMock).toHaveBeenCalledWith(
			'/tmp/workflow-marketplace',
		);
	});

	it('calls onComplete with name and pluginDirs on successful install', async () => {
		const onComplete = vi.fn();
		const {stdin} = render(
			<WorkflowStep onComplete={onComplete} onError={() => {}} />,
		);
		await new Promise(r => setTimeout(r, 50));
		stdin.write('\r');
		await new Promise(r => setTimeout(r, 50));
		expect(installWorkflowMock).toHaveBeenCalledWith(
			'e2e-test-builder@lespaceman/athena-workflow-marketplace',
		);
		expect(onComplete).toHaveBeenCalledWith('e2e-test-builder', [
			'/resolved/plugin/dir',
		]);
	});

	it('uses a local marketplace repo override when provided', async () => {
		process.env.ATHENA_STARTER_WORKFLOW_SOURCE =
			'/tmp/workflow-marketplace/workflows/local-workflow/workflow.json';
		findMarketplaceRepoDirMock.mockReturnValue('/tmp/workflow-marketplace');

		const {stdin} = render(
			<WorkflowStep onComplete={() => {}} onError={() => {}} />,
		);
		await new Promise(r => setTimeout(r, 50));
		stdin.write('\r');
		await new Promise(r => setTimeout(r, 50));

		expect(listMarketplaceWorkflowsFromRepoMock).toHaveBeenCalledWith(
			'/tmp/workflow-marketplace',
		);
		expect(installWorkflowMock).toHaveBeenCalledWith(
			'/tmp/workflow-marketplace/workflows/local-workflow/workflow.json',
		);
	});
});
