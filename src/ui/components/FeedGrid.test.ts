import {describe, expect, it} from 'vitest';
import {shouldUseLiveFeedScrollback} from './FeedGrid';

describe('shouldUseLiveFeedScrollback', () => {
	it('only enables static feed in tail-follow with no active search', () => {
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'normal',
				searchQuery: '',
			}),
		).toBe(true);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: false,
				inputMode: 'normal',
				searchQuery: '',
			}),
		).toBe(false);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'search',
				searchQuery: '',
			}),
		).toBe(false);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'normal',
				searchQuery: 'bash',
			}),
		).toBe(false);
	});
});
