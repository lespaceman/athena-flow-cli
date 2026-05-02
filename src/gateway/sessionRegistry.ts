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

export type SessionRegistryOptions = {
	/** Override UUID source for tests. */
	idFactory?: () => string;
	now?: () => number;
};

export class SessionRegistry {
	private current: RegisteredRuntime | null = null;
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
			throw new AlreadyRegisteredError(this.current);
		}
		this.current = {...input, registeredAt: this.now()};
		return this.current;
	}

	unregister(runtimeId: string): void {
		if (!this.current || this.current.runtimeId !== runtimeId) {
			throw new NotRegisteredError();
		}
		this.current = null;
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
