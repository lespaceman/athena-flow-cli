/**
 * Build `ChannelAdapter` instances from `~/.config/athena/channels/*.json`
 * sidecars. The gateway daemon calls `instantiateAdapters(sidecars)` on
 * startup before accepting client connections.
 *
 * Unknown channel names are reported as errors but do not abort startup —
 * a single misconfigured sidecar must not block other channels from coming
 * up. The gateway logs each registration outcome for operator diagnosis.
 */

import type {ChannelAdapter} from '../../shared/gateway-protocol';
import type {ChannelSidecar} from '../../infra/config/channels';
import {TelegramAdapter, type TelegramAdapterOptions} from './telegram/adapter';

export type InstantiateResult =
	| {ok: true; adapter: ChannelAdapter}
	| {ok: false; reason: string};

export function instantiateAdapter(sidecar: ChannelSidecar): InstantiateResult {
	switch (sidecar.name) {
		case 'telegram':
			return buildTelegramAdapter(sidecar);
		default:
			return {ok: false, reason: `unknown channel: ${sidecar.name}`};
	}
}

function buildTelegramAdapter(sidecar: ChannelSidecar): InstantiateResult {
	const token = sidecar.options['bot_token'];
	if (typeof token !== 'string' || token.length === 0) {
		return {ok: false, reason: 'telegram: bot_token missing'};
	}
	const defaultChatRaw = sidecar.options['default_chat_id'];
	const apiBaseRaw = sidecar.options['api_base'];
	const pollTimeoutRaw = sidecar.options['poll_timeout_sec'];
	const opts: TelegramAdapterOptions = {
		token,
		allowedUserIds: sidecar.allowedUserIds,
		...(typeof defaultChatRaw === 'string' || typeof defaultChatRaw === 'number'
			? {defaultChatId: defaultChatRaw}
			: {}),
		...(typeof apiBaseRaw === 'string' ? {apiBase: apiBaseRaw} : {}),
		...(typeof pollTimeoutRaw === 'number'
			? {pollTimeoutSec: pollTimeoutRaw}
			: {}),
	};
	return {ok: true, adapter: new TelegramAdapter(opts)};
}
