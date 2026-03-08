import {describe, it, expect} from 'vitest';
import {generateDeviceId, isValidDeviceId} from '../identity';

describe('identity', () => {
	it('generates a valid UUIDv4', () => {
		const id = generateDeviceId();
		expect(isValidDeviceId(id)).toBe(true);
	});

	it('generates unique IDs', () => {
		const id1 = generateDeviceId();
		const id2 = generateDeviceId();
		expect(id1).not.toBe(id2);
	});
});
