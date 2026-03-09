/**
 * Harness-neutral verification types.
 *
 * Shared by all harness verification implementations so that
 * harnesses never need to import from each other.
 */

export type HarnessVerificationCheck = {
	label: string;
	status: 'pass' | 'fail' | 'warn';
	message: string;
};

export type HarnessVerificationResult = {
	ok: boolean;
	summary: string;
	checks: HarnessVerificationCheck[];
};
