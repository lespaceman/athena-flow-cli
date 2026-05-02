/**
 * Gateway control-plane protocol: types only, no runtime.
 *
 * Imports are restricted to this leaf — see `eslint.config.js`. Both the
 * gateway daemon and any in-process Athena clients depend on these shapes.
 */
export type {
	ControlEnvelope,
	ControlResponseEnvelope,
	ControlPushEnvelope,
} from './envelope';
export type {
	ControlRequestKind,
	ControlPushKind,
	PingRequestPayload,
	PingResponsePayload,
	StatusRequestPayload,
	StatusResponsePayload,
	ChannelStatusEntry,
	SessionRegisterRequestPayload,
	SessionRegisterResponsePayload,
	SessionUnregisterRequestPayload,
	SessionUnregisterResponsePayload,
	SessionTurnCompleteRequestPayload,
	SessionTurnCompleteResponsePayload,
	ChannelSendRequestPayload,
	ChannelSendResponsePayload,
	SessionDispatchTurnPushPayload,
	RelayPermissionRequestPayload,
	RelayPermissionResponsePayload,
	RelayPermissionCancelRequestPayload,
	RelayPermissionCancelResponsePayload,
	RelayQuestionRequestPayload,
	RelayQuestionResponsePayload,
	RelayQuestionCancelRequestPayload,
	RelayQuestionCancelResponsePayload,
} from './control';
export type {
	ChannelLocation,
	ChannelAttachment,
	NormalizedInbound,
	OutboundMessage,
	SendResult,
	ProbeResult,
	HealthSample,
} from './channel-events';
export type {
	ChannelCapabilities,
	StopReason,
	AdapterLogger,
	AdapterContext,
	ChannelInboundListener,
	ChannelHealthListener,
	ChannelAdapter,
} from './adapter';
export type {
	RelayCancelReason,
	RelayQuestionOption,
	RelayQuestion,
	PermissionRelayRequest,
	PermissionRelayResult,
	QuestionRelayRequest,
	QuestionRelayResult,
} from './relay';
