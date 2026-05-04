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
export type {LocalEndpoint, RemoteEndpoint, RuntimeEndpoint} from './endpoint';
export {isSupportedGatewayUrl, parseRuntimeEndpoint} from './endpoint';
export type {
	ControlRequestKind,
	ControlPushKind,
	PingRequestPayload,
	PingResponsePayload,
	StatusRequestPayload,
	StatusResponsePayload,
	ChannelStatusEntry,
	ListenerStatusEntry,
	RuntimeStatusEntry,
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
export {peerLocation, roomLocation} from './channel-events';
export type {
	ChannelCapabilities,
	StopReason,
	AdapterLogger,
	AdapterContext,
	ChannelInboundListener,
	ChannelHealthListener,
	ChannelAdapter,
	AdapterModule,
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
export {
	CHANNEL_REQUEST_ID_LENGTH,
	CHANNEL_REQUEST_ID_REGEX,
	generateChannelRequestId,
	isValidChannelRequestId,
} from './channelRequestId';
export type {
	AthenaConsoleFrameKind,
	AthenaConsoleAddress,
	AthenaConsoleFrameBase,
	AthenaConsoleHelloFrame,
	AthenaConsoleReadyFrame,
	AthenaConsoleInboundMessageFrame,
	AthenaConsoleOutboundMessageFrame,
	AthenaConsolePermissionRequestFrame,
	AthenaConsolePermissionResponseFrame,
	AthenaConsoleQuestionRequestFrame,
	AthenaConsoleQuestionResponseFrame,
	AthenaConsoleAckFrame,
	AthenaConsoleErrorFrame,
	AthenaConsoleFrame,
} from './athenaConsole';
