import type { RegisteredTool, ToolHostFrame } from "../protocol/tool-host";

type RegisterFrame = Extract<ToolHostFrame, { type: "register" }>;
type ToolsChangedFrame = Extract<ToolHostFrame, { type: "tools_changed" }>;

export interface ToolHostOwner {
	readonly hostId: string;
	readonly sessionId: string;
	readonly generation: number;
}

interface SessionState {
	readonly owner: ToolHostOwner;
	tools: Map<string, RegisteredTool>;
}

function deepCloneFreeze(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(item => deepCloneFreeze(item)));
	if (typeof value !== "object" || value === null) return value;
	const copy = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(value)) copy[key] = deepCloneFreeze(nested);
	return Object.freeze(copy);
}

export class ToolHostRegistry {
	readonly #sessions = new Map<string, SessionState>();
	#nextGeneration = 1;

	register(frame: RegisterFrame): ToolHostOwner {
		const owner = Object.freeze({
			hostId: frame.hostId,
			sessionId: frame.sessionId,
			generation: this.#nextGeneration++,
		});
		this.#sessions.set(frame.sessionId, { owner, tools: this.#indexTools(frame.tools) });
		return owner;
	}

	update(owner: ToolHostOwner, tools: readonly RegisteredTool[]): void {
		const state = this.#requireOwner(owner);
		state.tools = this.#indexTools(tools);
	}

	apply(owner: ToolHostOwner, frame: ToolsChangedFrame | Extract<ToolHostFrame, { type: "unregister" }>): void {
		const state = this.#requireOwner(owner);
		if (frame.type === "tools_changed") {
			if (frame.sessionId !== owner.sessionId) throw new Error("tool host frame session does not match owner");
			state.tools = this.#indexTools(frame.tools);
			return;
		}
		if (frame.sessionId !== owner.sessionId) throw new Error("tool host frame session does not match owner");
		this.#sessions.delete(owner.sessionId);
	}

	unregister(owner: ToolHostOwner): void {
		this.#requireOwner(owner);
		this.#sessions.delete(owner.sessionId);
	}

	getTool(sessionId: string, toolName: string): RegisteredTool | undefined {
		return this.#sessions.get(sessionId)?.tools.get(toolName);
	}

	getTools(sessionId: string): readonly RegisteredTool[] {
		const state = this.#sessions.get(sessionId);
		return state === undefined ? [] : Object.freeze([...state.tools.values()]);
	}

	hasSession(sessionId: string): boolean {
		return this.#sessions.has(sessionId);
	}

	isCurrentOwner(owner: ToolHostOwner): boolean {
		return this.#stateForOwner(owner) !== undefined;
	}

	assertCurrentOwner(owner: ToolHostOwner): void {
		this.#requireOwner(owner);
	}
	getOwner(sessionId: string): ToolHostOwner | undefined {
		return this.#sessions.get(sessionId)?.owner;
	}

	#stateForOwner(owner: ToolHostOwner): SessionState | undefined {
		const state = this.#sessions.get(owner.sessionId);
		return state?.owner === owner ? state : undefined;
	}

	#requireOwner(owner: ToolHostOwner): SessionState {
		const state = this.#stateForOwner(owner);
		if (state === undefined) throw new Error("stale tool host owner");
		return state;
	}

	#indexTools(tools: readonly RegisteredTool[]): Map<string, RegisteredTool> {
		const indexed = new Map<string, RegisteredTool>();
		for (const tool of tools) {
			const storedTool = deepCloneFreeze(tool) as RegisteredTool;
			if (indexed.has(storedTool.name)) throw new Error(`duplicate tool name: ${storedTool.name}`);
			indexed.set(storedTool.name, storedTool);
		}
		return indexed;
	}
}
