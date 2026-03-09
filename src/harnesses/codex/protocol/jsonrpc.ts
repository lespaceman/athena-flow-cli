/** JSON-RPC 2.0 request (client → server). Note: no "jsonrpc" field on wire. */
export type JsonRpcRequest = {
	method: string;
	id: number;
	params?: Record<string, unknown>;
};

/** JSON-RPC 2.0 response (server → client). */
export type JsonRpcResponse = {
	id: number;
	result?: unknown;
	error?: {code: number; message: string};
};

/** JSON-RPC 2.0 notification (server → client, no id). */
export type JsonRpcNotification = {
	method: string;
	params?: Record<string, unknown>;
};

/** Server-initiated request (server → client, has id). */
export type JsonRpcServerRequest = {
	method: string;
	id: number;
	params?: Record<string, unknown>;
};

export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcResponse
	| JsonRpcNotification
	| JsonRpcServerRequest;

export function isResponse(
	msg: Record<string, unknown>,
): msg is JsonRpcResponse {
	return (
		'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)
	);
}

export function isNotification(
	msg: Record<string, unknown>,
): msg is JsonRpcNotification {
	return 'method' in msg && !('id' in msg);
}

export function isServerRequest(
	msg: Record<string, unknown>,
): msg is JsonRpcServerRequest {
	return 'method' in msg && 'id' in msg;
}
