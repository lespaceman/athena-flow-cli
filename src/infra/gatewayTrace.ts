/**
 * Cross-cutting gateway/runtime trace writer. Consumed by gateway daemon,
 * runtime SessionBridge, and the in-process feed/runtime providers. Lives
 * in `infra` (not `gateway/transport`) because it is a diagnostic
 * concern, not a transport-private API.
 *
 * Output is gated on `ATHENA_GATEWAY_TRACE=1`. When set, lines are
 * appended to `ATHENA_GATEWAY_TRACE_FILE` if writable, otherwise stderr.
 */

import fs from 'node:fs';

export function writeGatewayTrace(message: string): void {
	if (process.env['ATHENA_GATEWAY_TRACE'] !== '1') return;
	const line = `athena-gateway: [trace] ${message}\n`;
	const traceFile = process.env['ATHENA_GATEWAY_TRACE_FILE'];
	if (traceFile && traceFile.length > 0) {
		try {
			fs.appendFileSync(traceFile, line, 'utf-8');
			return;
		} catch {
			// fall through to stderr
		}
	}
	process.stderr.write(line);
}
