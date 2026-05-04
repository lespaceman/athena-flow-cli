import {writeGatewayTrace} from '../../infra/gatewayTrace';

export type GatewayTraceDirection = 'in' | 'out';

export function traceGatewayFrame(
	transport: string,
	peer: string,
	direction: GatewayTraceDirection,
	frame: unknown,
): void {
	if (process.env['ATHENA_GATEWAY_TRACE'] !== '1') return;
	writeGatewayTrace(
		`${transport} ${direction} ${peer} ${JSON.stringify(redactFrame(frame))}`,
	);
}

function redactFrame(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactFrame);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === 'token') {
			out[key] = '<redacted>';
			continue;
		}
		out[key] = redactFrame(child);
	}
	return out;
}
