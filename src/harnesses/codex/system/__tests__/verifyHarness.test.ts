import {describe, it, expect} from 'vitest';
import {isVersionSufficient} from '../verifyHarness';

describe('isVersionSufficient', () => {
	it('returns true for equal versions', () => {
		expect(isVersionSufficient('0.37.0', '0.37.0')).toBe(true);
	});

	it('returns true for higher versions', () => {
		expect(isVersionSufficient('0.42.0', '0.37.0')).toBe(true);
		expect(isVersionSufficient('1.0.0', '0.37.0')).toBe(true);
	});

	it('returns false for lower versions', () => {
		expect(isVersionSufficient('0.36.0', '0.37.0')).toBe(false);
		expect(isVersionSufficient('0.37.0', '0.38.0')).toBe(false);
	});
});
