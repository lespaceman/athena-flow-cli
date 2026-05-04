/**
 * Single-runtime session registry. Enforces the one-gateway/one-runtime
 * invariant called out in the plan: only one Athena interactive runtime can
 * register at a time; subsequent registrations are rejected with the
 * `already_registered` error code.
 *
 * Also owns in-flight dispatch correlation: when a chat inbound is routed,
 * the registry mints a `dispatchId`, parks the originating `ChannelLocation`
 * keyed by that id, and resolves the parked entry on `session.turn.complete`
 * so the gateway can relay the reply back on the correct channel.
 */

import {randomUUID} from 'node:crypto';
import type {ChannelLocation} from '../shared/gateway-protocol';

export type RegisteredRuntime = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	registeredAt: number;
};

export type RuntimeConnectionBinding =
	| {
			state: 'active';
			connectionId: string;
			boundAt: number;
			epoch: number;
			lastRebindAt?: number;
	  }
	| {
			state: 'stale';
			connectionId: string;
			staleSince: number;
			epoch: number;
			lastRebindAt?: number;
	  };

export type DispatchEntry = {
	dispatchId: string;
	sessionKey: string;
	agentId: string;
	location: ChannelLocation;
	createdAt: number;
};

export class AlreadyRegisteredError extends Error {
	readonly code = 'already_registered' as const;
	constructor(existing: RegisteredRuntime) {
		super(
			`gateway already has a registered runtime (pid=${existing.pid}, runtimeId=${existing.runtimeId})`,
		);
		this.name = 'AlreadyRegisteredError';
	}
}

export class NotRegisteredError extends Error {
	readonly code = 'not_registered' as const;
	constructor() {
		super('no runtime registered with gateway');
		this.name = 'NotRegisteredError';
	}
}

export class UnknownDispatchError extends Error {
	readonly code = 'unknown_dispatch' as const;
	constructor(id: string) {
		super(`unknown dispatchId: ${id}`);
		this.name = 'UnknownDispatchError';
	}
}

export function maybeLastRebindAt(value: number | undefined): {
	lastRebindAt?: number;
} {
	return value !== undefined ? {lastRebindAt: value} : {};
}

export type SessionRegistryOptions = {
	/** Override UUID source for tests. */
	idFactory?: () => string;
	now?: () => number;
};

export class SessionRegistry {
	private current: RegisteredRuntime | null = null;
	private binding: RuntimeConnectionBinding | null = null;
	private readonly dispatches = new Map<string, DispatchEntry>();
	private readonly idFactory: () => string;
	private readonly now: () => number;

	constructor(opts: SessionRegistryOptions = {}) {
		this.idFactory = opts.idFactory ?? randomUUID;
		this.now = opts.now ?? Date.now;
	}

	register(input: {
		runtimeId: string;
		defaultAgentId: string;
		pid: number;
	}): RegisteredRuntime {
		if (this.current) {
			if (this.current.runtimeId === input.runtimeId) {
				this.current = {
					...this.current,
					defaultAgentId: input.defaultAgentId,
					pid: input.pid,
				};
				return this.current;
			}
			throw new AlreadyRegisteredError(this.current);
		}
		this.current = {...input, registeredAt: this.now()};
		return this.current;
	}

	bindConnection(runtimeId: string, connectionId: string): void {
		if (!this.current || this.current.runtimeId !== runtimeId) {
			throw new NotRegisteredError();
		}
		const previous = this.binding;
		const now = this.now();
		const isRebind =
			previous !== null &&
			(previous.state === 'stale' || previous.connectionId !== connectionId);
		const lastRebindAt = isRebind ? now : previous?.lastRebindAt;
		const epoch = previous ? previous.epoch + (isRebind ? 1 : 0) : 1;
		this.binding = {
			state: 'active',
			connectionId,
			boundAt: now,
			epoch,
			...maybeLastRebindAt(lastRebindAt),
		};
	}

	markConnectionStale(connectionId: string): string | null {
		if (
			!this.current ||
			!this.binding ||
			this.binding.connectionId !== connectionId ||
			this.binding.state !== 'active'
		) {
			return null;
		}
		this.binding = {
			state: 'stale',
			connectionId,
			staleSince: this.now(),
			epoch: this.binding.epoch,
			...maybeLastRebindAt(this.binding.lastRebindAt),
		};
		return this.current.runtimeId;
	}

	hasActiveBinding(runtimeId?: string): boolean {
		if (!this.current || !this.binding || this.binding.state !== 'active') {
			return false;
		}
		return runtimeId === undefined || this.current.runtimeId === runtimeId;
	}

	getBinding(): RuntimeConnectionBinding | null {
		return this.binding;
	}

	getRuntimeIdByConnection(connectionId: string): string | null {
		if (!this.current || !this.binding) return null;
		return this.binding.connectionId === connectionId
			? this.current.runtimeId
			: null;
	}

	unregister(runtimeId: string): void {
		if (!this.current || this.current.runtimeId !== runtimeId) {
			throw new NotRegisteredError();
		}
		this.current = null;
		this.binding = null;
		this.dispatches.clear();
	}

	getCurrent(): RegisteredRuntime | null {
		return this.current;
	}

	beginDispatch(input: {
		sessionKey: string;
		agentId: string;
		location: ChannelLocation;
	}): DispatchEntry {
		if (!this.current) {
			throw new NotRegisteredError();
		}
		const dispatchId = this.idFactory();
		const entry: DispatchEntry = {
			dispatchId,
			sessionKey: input.sessionKey,
			agentId: input.agentId,
			location: input.location,
			createdAt: this.now(),
		};
		this.dispatches.set(dispatchId, entry);
		return entry;
	}

	completeDispatch(dispatchId: string): DispatchEntry {
		const entry = this.dispatches.get(dispatchId);
		if (!entry) {
			throw new UnknownDispatchError(dispatchId);
		}
		this.dispatches.delete(dispatchId);
		return entry;
	}

	pendingDispatchCount(): number {
		return this.dispatches.size;
	}
}
