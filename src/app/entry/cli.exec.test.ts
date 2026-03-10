import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const renderMock = vi.fn();
const runExecMock = vi.fn();
const bootstrapRuntimeConfigMock = vi.fn();
const readConfigMock = vi.fn();
const readGlobalConfigMock = vi.fn();
const writeGlobalConfigMock = vi.fn();
const getMostRecentAthenaSessionMock = vi.fn();
const getSessionMetaMock = vi.fn();
const shouldShowSetupMock = vi.fn();
const resolveThemeMock = vi.fn(() => ({name: 'dark'}));
const initTelemetryMock = vi.fn();
const shutdownTelemetryMock = vi.fn().mockResolvedValue(undefined);
const generateDeviceIdMock = vi.fn(() => 'generated-device-id');
const trackAppLaunchedMock = vi.fn();
const trackErrorMock = vi.fn();
const trackTelemetryOptedOutMock = vi.fn();
const resolveWorkflowInstallSourceMock = vi.fn((source: string) => source);

const EXEC_EXIT_CODE = {
	SUCCESS: 0,
	USAGE: 2,
	BOOTSTRAP: 3,
	RUNTIME: 4,
	POLICY: 5,
	TIMEOUT: 6,
	OUTPUT: 7,
} as const;

vi.mock('ink', () => ({
	render: renderMock,
}));

vi.mock('../shell/AppShell', () => ({
	default: () => null,
}));

vi.mock('../../setup/steps/WorkflowInstallWizard', () => ({
	default: () => null,
}));

vi.mock('../commands/builtins/index', () => ({
	registerBuiltins: vi.fn(),
}));

vi.mock('../../infra/plugins/index', () => ({
	readConfig: readConfigMock,
	readGlobalConfig: readGlobalConfigMock,
}));

vi.mock('../../infra/plugins/config', () => ({
	writeGlobalConfig: writeGlobalConfigMock,
}));

vi.mock('../bootstrap/bootstrapConfig', () => ({
	bootstrapRuntimeConfig: bootstrapRuntimeConfigMock,
}));

vi.mock('../../infra/sessions/index', () => ({
	getMostRecentAthenaSession: getMostRecentAthenaSessionMock,
	getSessionMeta: getSessionMetaMock,
}));

vi.mock('../../setup/shouldShowSetup', () => ({
	shouldShowSetup: shouldShowSetupMock,
}));

vi.mock('../exec', () => ({
	runExec: runExecMock,
	EXEC_EXIT_CODE,
	EXEC_PERMISSION_POLICIES: ['allow', 'deny', 'fail'],
	EXEC_QUESTION_POLICIES: ['empty', 'fail'],
	EXEC_DEFAULT_PERMISSION_POLICY: 'fail',
	EXEC_DEFAULT_QUESTION_POLICY: 'fail',
}));

vi.mock('../../ui/theme/index', () => ({
	resolveTheme: resolveThemeMock,
}));

vi.mock('../../infra/plugins/marketplace', () => ({
	resolveWorkflowInstallSource: (...args: unknown[]) =>
		resolveWorkflowInstallSourceMock(...args),
}));

vi.mock('../../infra/telemetry/index', () => ({
	initTelemetry: initTelemetryMock,
	shutdownTelemetry: shutdownTelemetryMock,
	generateDeviceId: generateDeviceIdMock,
	trackAppLaunched: trackAppLaunchedMock,
	trackError: trackErrorMock,
	trackTelemetryOptedOut: trackTelemetryOptedOutMock,
}));

vi.mock('../../shared/utils/processRegistry', () => ({
	processRegistry: {
		registerCleanupHandlers: vi.fn(),
	},
}));

type CliRunResult = {
	exitSpy: ReturnType<typeof vi.spyOn>;
	errorSpy: ReturnType<typeof vi.spyOn>;
	logSpy: ReturnType<typeof vi.spyOn>;
	restore: () => void;
};

const BASE_CONFIG = {
	plugins: [] as string[],
	additionalDirectories: [] as string[],
	setupComplete: true,
	deviceId: 'device-id-1',
};

const BASE_RUNTIME_BOOTSTRAP = {
	globalConfig: BASE_CONFIG,
	projectConfig: BASE_CONFIG,
	harness: 'claude-code' as const,
	isolationConfig: {},
	pluginMcpConfig: undefined,
	workflowRef: undefined,
	workflow: undefined,
	workflowPlan: undefined,
	modelName: null,
	warnings: [] as string[],
};

async function runCli(args: string[]): Promise<CliRunResult> {
	vi.resetModules();
	const previousArgv = process.argv;
	process.argv = ['node', 'athena-flow', ...args];

	const exitSpy = vi
		.spyOn(process, 'exit')
		.mockImplementation((() => undefined) as never);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

	await import('./cli.tsx');
	await new Promise(resolve => setImmediate(resolve));

	return {
		exitSpy,
		errorSpy,
		logSpy,
		restore: () => {
			process.argv = previousArgv;
			exitSpy.mockRestore();
			errorSpy.mockRestore();
			logSpy.mockRestore();
		},
	};
}

describe('cli exec mode', () => {
	beforeEach(() => {
		renderMock.mockReset();
		renderMock.mockReturnValue({
			waitUntilExit: vi.fn().mockResolvedValue(undefined),
		});
		runExecMock.mockReset();
		bootstrapRuntimeConfigMock.mockReset();
		readConfigMock.mockReset();
		readGlobalConfigMock.mockReset();
		writeGlobalConfigMock.mockReset();
		getMostRecentAthenaSessionMock.mockReset();
		getSessionMetaMock.mockReset();
		shouldShowSetupMock.mockReset();
		resolveThemeMock.mockReset();
		initTelemetryMock.mockReset();
		shutdownTelemetryMock.mockClear();
		generateDeviceIdMock.mockClear();
		trackAppLaunchedMock.mockReset();
		trackErrorMock.mockReset();
		trackTelemetryOptedOutMock.mockReset();
		resolveWorkflowInstallSourceMock.mockReset();
		resolveWorkflowInstallSourceMock.mockImplementation(
			(source: string) => source,
		);

		readConfigMock.mockReturnValue(BASE_CONFIG);
		readGlobalConfigMock.mockReturnValue(BASE_CONFIG);
		bootstrapRuntimeConfigMock.mockReturnValue(BASE_RUNTIME_BOOTSTRAP);
		resolveThemeMock.mockReturnValue({name: 'dark'});
		runExecMock.mockResolvedValue({exitCode: EXEC_EXIT_CODE.SUCCESS});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('dispatches exec command to runExec and bypasses Ink render', async () => {
		const cli = await runCli(['exec', 'hello from test']);
		try {
			expect(runExecMock).toHaveBeenCalledTimes(1);
			expect(runExecMock).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'hello from test',
					onPermission: 'fail',
					onQuestion: 'fail',
				}),
			);
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.SUCCESS);
			expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
				expect.objectContaining({
					showSetup: false,
				}),
			);
			expect(shouldShowSetupMock).not.toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});

	it('fails fast when exec prompt is missing', async () => {
		const cli = await runCli(['exec']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(bootstrapRuntimeConfigMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.USAGE);
		} finally {
			cli.restore();
		}
	});

	it('rejects --ephemeral with --continue', async () => {
		const cli = await runCli(['exec', 'hello', '--ephemeral', '--continue']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.USAGE);
		} finally {
			cli.restore();
		}
	});

	it('validates invalid --on-permission policy', async () => {
		const cli = await runCli(['exec', 'hello', '--on-permission=invalid']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.USAGE);
		} finally {
			cli.restore();
		}
	});

	it('resolves bare --continue to most recent session', async () => {
		getMostRecentAthenaSessionMock.mockReturnValue({
			id: 'athena-1',
			adapterSessionIds: ['adapter-1', 'adapter-2'],
		});

		const cli = await runCli(['exec', 'hello', '--continue']);
		try {
			expect(runExecMock).toHaveBeenCalledWith(
				expect.objectContaining({
					athenaSessionId: 'athena-1',
					adapterResumeSessionId: 'adapter-2',
				}),
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.SUCCESS);
		} finally {
			cli.restore();
		}
	});

	it('fails when explicit --continue session id is unknown', async () => {
		getSessionMetaMock.mockReturnValue(null);

		const cli = await runCli(['exec', 'hello', '--continue=missing']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.RUNTIME);
		} finally {
			cli.restore();
		}
	});

	it('keeps interactive mode path unchanged', async () => {
		const cli = await runCli([]);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).toHaveBeenCalledTimes(1);
			expect(renderMock.mock.calls[0]?.[1]).not.toHaveProperty(
				'incrementalRendering',
			);
			expect(cli.exitSpy).not.toHaveBeenCalled();
			expect(shouldShowSetupMock).toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});

	it('suppresses the first-run telemetry notice in exec mode', async () => {
		readGlobalConfigMock.mockReturnValue({
			...BASE_CONFIG,
			deviceId: undefined,
		});

		const cli = await runCli(['exec', 'hello from test', '--json']);
		try {
			expect(writeGlobalConfigMock).toHaveBeenCalledWith({
				deviceId: 'generated-device-id',
			});
			expect(cli.logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Athena collects anonymous usage data'),
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.SUCCESS);
		} finally {
			cli.restore();
		}
	});

	it('tracks telemetry opt-out for the CLI disable command', async () => {
		readGlobalConfigMock.mockReturnValue({
			...BASE_CONFIG,
			telemetry: true,
		});

		const cli = await runCli(['telemetry', 'disable']);
		try {
			expect(initTelemetryMock).toHaveBeenCalledWith(
				expect.objectContaining({
					deviceId: 'device-id-1',
					telemetryEnabled: true,
				}),
			);
			expect(trackTelemetryOptedOutMock).toHaveBeenCalledTimes(1);
			expect(shutdownTelemetryMock).toHaveBeenCalled();
			expect(writeGlobalConfigMock).toHaveBeenCalledWith({telemetry: false});
		} finally {
			cli.restore();
		}
	});

	it('uses exec-specific bootstrap exit code in exec mode', async () => {
		bootstrapRuntimeConfigMock.mockImplementation(() => {
			throw new Error('bootstrap failed');
		});

		const cli = await runCli(['exec', 'hello']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(EXEC_EXIT_CODE.BOOTSTRAP);
		} finally {
			cli.restore();
		}
	});

	it('preserves interactive bootstrap failure exit code', async () => {
		bootstrapRuntimeConfigMock.mockImplementation(() => {
			throw new Error('bootstrap failed');
		});

		const cli = await runCli([]);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(1);
		} finally {
			cli.restore();
		}
	});

	it('routes workflow install through the interactive install wizard path', async () => {
		const cli = await runCli(['workflow', 'install', 'e2e-test-builder']);
		try {
			await new Promise(resolve => setImmediate(resolve));
			expect(renderMock).toHaveBeenCalledTimes(1);
			expect(resolveWorkflowInstallSourceMock).toHaveBeenCalledWith(
				'e2e-test-builder',
				'lespaceman/athena-workflow-marketplace',
			);
			expect(cli.exitSpy).not.toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});
});
