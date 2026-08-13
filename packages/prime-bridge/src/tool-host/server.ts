import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { McpToolResult, ToolHostFrame } from "../protocol/tool-host";
import { parseToolHostFrame } from "../protocol/tool-host";
import { type ToolHostOwner, ToolHostRegistry } from "./registry";

export const TOOL_HOST_MAX_AUDIT_ENTRIES = 1_000;
export const TOOL_HOST_MAX_FRAME_BYTES = 1_048_576;
export const TOOL_HOST_MAX_OUTBOUND_QUEUE = 100;
export const TOOL_HOST_MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;
export const TOOL_HOST_HEARTBEAT_INTERVAL_MS = 30_000;
export const TOOL_HOST_HEARTBEAT_TIMEOUT_MS = 90_000;
export const TOOL_HOST_MAX_CANCELED_PER_OWNER = 256;
export const TOOL_HOST_CALL_TIMEOUT_MS = 61_000;

export interface ToolHostServerOptions {
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	callTimeoutMs?: number;
	onAudit?: (entry: ToolHostAuditEntry) => void;
}

export interface ToolHostAuditEntry {
	action: "register" | "tools_changed" | "call" | "result" | "error" | "disconnect";
	sessionId?: string;
	requestId?: string;
	toolName?: string;
	code?: string;
}

interface PendingCall {
	readonly sessionId: string;
	readonly owner: ToolHostOwner;
	readonly socket: HostSocket;
	readonly resolve: (result: McpToolResult) => void;
	readonly reject: (error: Error) => void;
	readonly timer: Timer;
	readonly signal?: AbortSignal;
	readonly abortListener?: () => void;
	acceptedByBun: boolean;
}

export type ToolHostOutboundKind = "call_tool" | "cancel_tool";
export interface ToolHostOutboundEntry {
	readonly text: string;
	readonly requestId?: string;
	readonly kind?: ToolHostOutboundKind;
	accepted: boolean;
}

export interface ToolHostOutboundMetadata {
	readonly requestId?: string;
	readonly kind?: ToolHostOutboundKind;
}

export interface ToolHostHeartbeatSocket {
	awaitingPong: boolean;
	heartbeatTimeout?: Timer;
	closed: boolean;
	readyState?: number;
}

export interface ToolHostOutboundState {
	queue: ToolHostOutboundEntry[];
	queuedBytes: number;
	backpressured: boolean;
}

export type ToolHostSendStatus = -1 | 0 | 1;
export function heartbeatToolHostSocket(
	ws: ToolHostHeartbeatSocket,
	timeoutMs: number,
	ping: () => void,
	terminate: () => void,
): void {
	if (ws.closed || (ws.readyState !== undefined && ws.readyState !== 1) || ws.awaitingPong) return;
	ws.awaitingPong = true;
	ping();
	ws.heartbeatTimeout = setTimeout(() => {
		ws.heartbeatTimeout = undefined;
		if (ws.awaitingPong && (ws.readyState === undefined || ws.readyState === 1)) terminate();
	}, timeoutMs);
}
export function sendToolHostFrame(
	state: ToolHostOutboundState,
	send: (text: string) => ToolHostSendStatus,
	text: string,
	metadata: ToolHostOutboundMetadata = {},
): boolean {
	const bytes = frameBytes(text);
	if (bytes > TOOL_HOST_MAX_FRAME_BYTES) throw new Error("outbound frame is too large");
	const entry: ToolHostOutboundEntry = {
		text,
		accepted: false,
		...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId }),
		...(metadata.kind === undefined ? {} : { kind: metadata.kind }),
	};
	if (state.backpressured || state.queue.length > 0) {
		if (
			state.queue.length >= TOOL_HOST_MAX_OUTBOUND_QUEUE ||
			state.queuedBytes + bytes > TOOL_HOST_MAX_OUTBOUND_BYTES
		)
			throw new Error("tool host outbound queue is full");
		state.queue.push(entry);
		state.queuedBytes += bytes;
		return false;
	}
	const status = send(text);
	if (status === 0) throw new Error("tool host socket dropped outbound frame");
	entry.accepted = true;
	if (status < 0) state.backpressured = true;
	return true;
}

export function removeToolHostQueuedFrame(
	state: ToolHostOutboundState,
	requestId: string,
	kind: ToolHostOutboundKind,
): boolean {
	const index = state.queue.findIndex(
		entry => entry.requestId === requestId && entry.kind === kind && !entry.accepted,
	);
	if (index < 0) return false;
	const [entry] = state.queue.splice(index, 1);
	if (entry === undefined) return false;
	state.queuedBytes -= frameBytes(entry.text);
	return true;
}

export function drainToolHostFrames(
	state: ToolHostOutboundState,
	send: (text: string, entry: ToolHostOutboundEntry) => ToolHostSendStatus,
): void {
	while (state.queue.length > 0) {
		const entry = state.queue[0];
		if (entry === undefined) return;
		const status = send(entry.text, entry);
		state.queue.shift();
		state.queuedBytes -= frameBytes(entry.text);
		if (status === 0) continue;
		entry.accepted = true;
		if (status < 0) return;
	}
	state.backpressured = false;
}

interface SocketData {
	owner?: ToolHostOwner;
	awaitingPong: boolean;
	heartbeatTimeout?: Timer;
	closed: boolean;
	queue: ToolHostOutboundEntry[];
	queuedBytes: number;
	backpressured: boolean;
}

type HostSocket = ServerWebSocket<SocketData>;

function frameBytes(frame: string): number {
	return new TextEncoder().encode(frame).byteLength;
}

function socketIsOpen(ws: HostSocket): boolean {
	return ws.readyState === 1;
}

export class ToolHostServer {
	readonly registry = new ToolHostRegistry();
	readonly #auditEntries: ToolHostAuditEntry[] = [];
	readonly #auditListeners = new Set<(entry: ToolHostAuditEntry) => void>();
	readonly #sockets = new Set<HostSocket>();
	readonly #sessionSockets = new Map<string, HostSocket>();
	readonly #pending = new Map<string, PendingCall>();
	readonly #canceled = new Map<ToolHostOwner, Map<string, true>>();
	readonly #options: Required<Omit<ToolHostServerOptions, "onAudit">> & Pick<ToolHostServerOptions, "onAudit">;
	readonly #heartbeatTimer: Timer;
	constructor(options: ToolHostServerOptions = {}) {
		this.#options = {
			heartbeatIntervalMs: options.heartbeatIntervalMs ?? TOOL_HOST_HEARTBEAT_INTERVAL_MS,
			heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? TOOL_HOST_HEARTBEAT_TIMEOUT_MS,
			callTimeoutMs: options.callTimeoutMs ?? TOOL_HOST_CALL_TIMEOUT_MS,
			...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
		};
		this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.#options.heartbeatIntervalMs);
	}

	get websocket(): Bun.WebSocketHandler<SocketData> {
		return {
			data: {} as SocketData,
			maxPayloadLength: TOOL_HOST_MAX_FRAME_BYTES,
			backpressureLimit: TOOL_HOST_MAX_OUTBOUND_BYTES,
			closeOnBackpressureLimit: true,
			open: ws => {
				this.#sockets.add(ws);
			},
			message: (ws, message) => this.#message(ws, message),
			drain: ws => this.#drain(ws),
			pong: ws => {
				ws.data.awaitingPong = false;
				if (ws.data.heartbeatTimeout !== undefined) {
					clearTimeout(ws.data.heartbeatTimeout);
					ws.data.heartbeatTimeout = undefined;
				}
			},
			close: (ws, code, reason) => this.#close(ws, code, reason),
		};
	}

	get tools(): ToolHostRegistry {
		return this.registry;
	}

	audit(): readonly ToolHostAuditEntry[] {
		return [...this.#auditEntries];
	}
	subscribeAudit(listener: (entry: ToolHostAuditEntry) => void): () => void {
		this.#auditListeners.add(listener);
		return () => this.#auditListeners.delete(listener);
	}

	async callTool(
		sessionId: string,
		toolName: string,
		argumentsValue: unknown,
		signal?: AbortSignal,
	): Promise<McpToolResult> {
		if (signal?.aborted) throw new Error("tool call aborted");
		const owner = this.registry.getOwner(sessionId);
		const ws = this.#sessionSockets.get(sessionId);
		if (owner === undefined || ws === undefined || !socketIsOpen(ws))
			throw new Error(`tool host session is disconnected: ${sessionId}`);
		if (this.registry.getTool(sessionId, toolName) === undefined) throw new Error(`unknown tool: ${toolName}`);
		const canceled = this.#canceled.get(owner);
		let acceptedPending = 0;
		for (const pending of this.#pending.values())
			if (pending.owner === owner && pending.acceptedByBun) acceptedPending += 1;
		if ((canceled?.size ?? 0) + acceptedPending >= TOOL_HOST_MAX_CANCELED_PER_OWNER)
			throw new Error(`tool host cancellation capacity exhausted: ${sessionId}`);
		const requestId = randomUUID();
		const frame: ToolHostFrame = { type: "call_tool", requestId, sessionId, toolName, arguments: argumentsValue };
		const { promise, resolve, reject } = Promise.withResolvers<McpToolResult>();
		const settleCanceled = (error: Error): void => {
			const pending = this.#pending.get(requestId);
			if (pending === undefined) return;
			this.#pending.delete(requestId);
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abortListener!);
			removeToolHostQueuedFrame(ws.data, requestId, "call_tool");
			if (pending.acceptedByBun) {
				this.#rememberCanceled(requestId, owner);
			}
			if (pending.acceptedByBun) {
				try {
					this.#send(ws, JSON.stringify({ type: "cancel_tool", requestId, sessionId }), {
						requestId,
						kind: "cancel_tool",
					});
				} catch {
					// The host disconnected before cancellation could be sent.
				}
			}
			pending.reject(error);
		};
		const abortListener = (): void => settleCanceled(new Error(`tool call aborted: ${requestId}`));
		const timer = setTimeout(
			() => settleCanceled(new Error(`tool call timed out: ${requestId}`)),
			this.#options.callTimeoutMs,
		);
		this.#pending.set(requestId, {
			sessionId,
			owner,
			socket: ws,
			resolve,
			reject,
			timer,
			acceptedByBun: false,
			...(signal === undefined ? {} : { signal, abortListener }),
		});
		signal?.addEventListener("abort", abortListener, { once: true });
		this.#audit({ action: "call", sessionId, requestId, toolName });
		try {
			const pending = this.#pending.get(requestId);
			if (pending !== undefined)
				pending.acceptedByBun = this.#send(ws, JSON.stringify(frame), { requestId, kind: "call_tool" });
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(requestId);
			removeToolHostQueuedFrame(ws.data, requestId, "call_tool");
			signal?.removeEventListener("abort", abortListener);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	#heartbeat(): void {
		for (const ws of [...this.#sockets])
			heartbeatToolHostSocket(
				ws.data,
				this.#options.heartbeatTimeoutMs,
				() => ws.ping(),
				() => ws.terminate(),
			);
	}
	close(): void {
		clearInterval(this.#heartbeatTimer);
		for (const ws of [...this.#sockets]) {
			this.#closeState(ws);
			ws.terminate();
		}
		for (const [requestId, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abortListener!);
			removeToolHostQueuedFrame(pending.socket.data, requestId, "call_tool");
			pending.reject(new Error("tool host server stopped"));
		}
		this.#pending.clear();
		this.#canceled.clear();
	}
	#message(ws: HostSocket, raw: string | Buffer<ArrayBuffer>): void {
		const text = typeof raw === "string" ? raw : raw.toString("utf8");
		if (frameBytes(text) > TOOL_HOST_MAX_FRAME_BYTES) {
			ws.close(1009, "frame too large");
			return;
		}
		let frame: ToolHostFrame;
		try {
			frame = parseToolHostFrame(text);
		} catch {
			ws.close(1003, "invalid tool host frame");
			return;
		}
		try {
			switch (frame.type) {
				case "register":
					this.#register(ws, frame);
					return;
				case "tools_changed":
					this.#requireOwner(ws, frame.sessionId);
					this.registry.apply(ws.data.owner!, frame);
					this.#audit({ action: "tools_changed", sessionId: frame.sessionId });
					return;
				case "tool_result":
					if (
						this.#pending.get(frame.requestId) === undefined &&
						this.#consumeCanceled(ws.data.owner, frame.requestId)
					)
						return;
					this.#requireResponder(ws, frame.requestId);
					this.#resolveResult(frame);
					return;
				case "tool_error":
					if (
						this.#pending.get(frame.requestId) === undefined &&
						this.#consumeCanceled(ws.data.owner, frame.requestId)
					)
						return;
					this.#requireResponder(ws, frame.requestId);
					this.#resolveError(frame);
					return;
				case "unregister":
					this.#requireOwner(ws, frame.sessionId);
					this.#unregisterState(ws);
					return;
				case "call_tool":
				case "cancel_tool":
					ws.close(1008, "host cannot call tools");
					return;
			}
		} catch {
			ws.close(1008, "invalid tool host state");
		}
	}

	#register(ws: HostSocket, frame: Extract<ToolHostFrame, { type: "register" }>): void {
		if (ws.data.owner !== undefined) {
			ws.close(1008, "host already registered");
			return;
		}
		const oldSocket = this.#sessionSockets.get(frame.sessionId);
		if (oldSocket !== undefined && oldSocket !== ws) {
			this.#closeState(oldSocket);
			oldSocket.close(4009, "replaced by reconnect");
		}
		const owner = this.registry.register(frame);
		ws.data.owner = owner;
		this.#sessionSockets.set(frame.sessionId, ws);
		this.#audit({ action: "register", sessionId: frame.sessionId });
	}

	#resolveResult(frame: Extract<ToolHostFrame, { type: "tool_result" }>): void {
		const pending = this.#pending.get(frame.requestId);
		if (pending === undefined) return;
		this.#pending.delete(frame.requestId);
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.abortListener!);
		this.#audit({ action: "result", sessionId: pending.sessionId, requestId: frame.requestId });
		pending.resolve(frame.result);
	}

	#resolveError(frame: Extract<ToolHostFrame, { type: "tool_error" }>): void {
		const pending = this.#pending.get(frame.requestId);
		if (pending === undefined) return;
		this.#pending.delete(frame.requestId);
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.abortListener!);
		this.#audit({ action: "error", sessionId: pending.sessionId, requestId: frame.requestId, code: frame.code });
		pending.reject(new Error(`${frame.code}: ${frame.message}`));
	}
	#send(ws: HostSocket, text: string, metadata: ToolHostOutboundMetadata = {}): boolean {
		if (!socketIsOpen(ws)) throw new Error("tool host socket is closed");
		return sendToolHostFrame(ws.data, value => ws.sendText(value) as ToolHostSendStatus, text, metadata);
	}

	#drain(ws: HostSocket): void {
		if (!socketIsOpen(ws)) return;
		drainToolHostFrames(ws.data, (value, entry) => {
			const status = ws.sendText(value) as ToolHostSendStatus;
			if (status === 0 && entry.kind === "call_tool" && entry.requestId !== undefined)
				this.#rejectDroppedQueuedCall(ws, entry.requestId);
			if (status !== 0 && entry.kind === "call_tool" && entry.requestId !== undefined) {
				const pending = this.#pending.get(entry.requestId);
				if (pending !== undefined) pending.acceptedByBun = true;
			}
			return status;
		});
	}

	#rejectDroppedQueuedCall(ws: HostSocket, requestId: string): void {
		const pending = this.#pending.get(requestId);
		if (pending === undefined || pending.socket !== ws) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.abortListener!);
		pending.reject(new Error(`tool host socket dropped outbound frame: ${requestId}`));
	}

	#rememberCanceled(requestId: string, owner: ToolHostOwner): void {
		let requests = this.#canceled.get(owner);
		if (requests === undefined) {
			requests = new Map();
			this.#canceled.set(owner, requests);
		}
		requests.set(requestId, true);
	}

	#consumeCanceled(owner: ToolHostOwner | undefined, requestId: string): boolean {
		if (owner === undefined) return false;
		const requests = this.#canceled.get(owner);
		if (requests === undefined || !requests.delete(requestId)) return false;
		if (requests.size === 0) this.#canceled.delete(owner);
		return true;
	}

	#requireOwner(ws: HostSocket, sessionId: string): void {
		if (
			ws.data.owner === undefined ||
			ws.data.owner.sessionId !== sessionId ||
			!this.registry.isCurrentOwner(ws.data.owner)
		)
			throw new Error("stale tool host owner");
	}

	#requireResponder(ws: HostSocket, requestId: string): void {
		const pending = this.#pending.get(requestId);
		if (
			pending === undefined ||
			pending.socket !== ws ||
			pending.owner !== ws.data.owner ||
			!this.registry.isCurrentOwner(pending.owner)
		)
			throw new Error("tool host response owner mismatch");
	}

	#close(ws: HostSocket, _code: number, _reason: string): void {
		this.#closeState(ws);
	}
	#unregisterState(ws: HostSocket): void {
		const owner = ws.data.owner;
		if (owner === undefined || !this.registry.isCurrentOwner(owner)) throw new Error("stale tool host owner");
		ws.data.owner = undefined;
		this.registry.unregister(owner);
		this.#canceled.delete(owner);
		if (this.#sessionSockets.get(owner.sessionId) === ws) this.#sessionSockets.delete(owner.sessionId);
		this.#audit({ action: "disconnect", sessionId: owner.sessionId });
		for (const [requestId, pending] of this.#pending) {
			if (pending.owner !== owner) continue;
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abortListener!);
			removeToolHostQueuedFrame(pending.socket.data, requestId, "call_tool");
			pending.reject(new Error(`tool host disconnected: ${owner.sessionId}`));
			this.#pending.delete(requestId);
		}
	}

	#closeState(ws: HostSocket): void {
		if (ws.data.closed) return;
		ws.data.closed = true;
		if (ws.data.heartbeatTimeout !== undefined) {
			clearTimeout(ws.data.heartbeatTimeout);
			ws.data.heartbeatTimeout = undefined;
		}
		this.#sockets.delete(ws);
		const owner = ws.data.owner;
		if (owner !== undefined) this.#canceled.delete(owner);
		if (owner === undefined || !this.registry.isCurrentOwner(owner)) return;
		this.registry.unregister(owner);
		if (this.#sessionSockets.get(owner.sessionId) === ws) this.#sessionSockets.delete(owner.sessionId);
		this.#audit({ action: "disconnect", sessionId: owner.sessionId });
		for (const [requestId, pending] of this.#pending) {
			if (pending.sessionId !== owner.sessionId) continue;
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abortListener!);
			removeToolHostQueuedFrame(pending.socket.data, requestId, "call_tool");
			pending.reject(new Error(`tool host disconnected: ${owner.sessionId}`));
			this.#pending.delete(requestId);
		}
	}

	#audit(entry: ToolHostAuditEntry): void {
		const safeEntry = { ...entry };
		this.#auditEntries.push(safeEntry);
		if (this.#auditEntries.length > TOOL_HOST_MAX_AUDIT_ENTRIES) this.#auditEntries.shift();
		this.#options.onAudit?.(safeEntry);
		for (const listener of this.#auditListeners) listener(safeEntry);
	}
}
