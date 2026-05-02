/**
 * Stable path for the in-daemon `ChannelAdapter` contract. Re-exports the
 * canonical definition from `shared/gateway-protocol/adapter` so existing
 * channel-layer code can reach the contract without crossing layer rules.
 */
export type {
	AdapterContext,
	AdapterLogger,
	ChannelAdapter,
	ChannelCapabilities,
	ChannelHealthListener,
	ChannelInboundListener,
	StopReason,
} from '../shared/gateway-protocol/adapter';
