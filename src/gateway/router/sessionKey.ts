/**
 * SessionKey ladder. Deterministic, first-match-wins. Resolves a normalized
 * inbound message into the canonical key the gateway uses to route turns.
 *
 * Order (per plan):
 *   1. peer:{channel}:{account}:{peerId}:{threadId}
 *   2. peer:{channel}:{account}:{peerId}
 *   3. room:{channel}:{account}:{roomId}:{threadId}
 *   4. room:{channel}:{account}:{roomId}
 *   5. default:{channel}:{account}
 */

import type {ChannelLocation} from '../../shared/gateway-protocol';

export function deriveSessionKey(loc: ChannelLocation): string {
	const c = loc.channelId;
	const a = loc.accountId;
	if (loc.peer?.id) {
		const peer = loc.peer.id;
		if (loc.thread?.id) {
			return `peer:${c}:${a}:${peer}:${loc.thread.id}`;
		}
		return `peer:${c}:${a}:${peer}`;
	}
	if (loc.room?.id) {
		const room = loc.room.id;
		if (loc.thread?.id) {
			return `room:${c}:${a}:${room}:${loc.thread.id}`;
		}
		return `room:${c}:${a}:${room}`;
	}
	return `default:${c}:${a}`;
}
