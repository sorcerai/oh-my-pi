export type FauxOpenAIMessage = {
	readonly role: string;
	readonly content?: unknown;
	readonly name?: string;
	readonly tool_call_id?: string;
	readonly tool_calls?: readonly {
		readonly id?: unknown;
		readonly type?: unknown;
		readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
	}[];
};

export type FauxOpenAIRequest = {
	readonly model: string;
	readonly messages: readonly FauxOpenAIMessage[];
	readonly stream?: boolean;
	readonly [key: string]: unknown;
};

export type FauxOpenAIRequestRecord = {
	readonly request: FauxOpenAIRequest;
	readonly valid: boolean;
	readonly error?: string;
};

export type FauxOpenAIProvider = {
	readonly url: string;
	readonly requests: FauxOpenAIRequestRecord[];
	readonly stop: () => Promise<void>;
};

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	const record = value as Record<string, unknown>;
	return record;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter(item => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
			const block = object(item, "content block");
			return block.type === "text";
		})
		.map(item => {
			const block = object(item, "content block");
			return String(block.text ?? "");
		})
		.join(" ");
}

function requestMessages(value: unknown): FauxOpenAIMessage[] {
	if (!Array.isArray(value)) throw new Error("request messages must be an array");
	return value.map((item, index) => {
		const record = object(item, `request message ${index}`);
		if (typeof record.role !== "string") throw new Error(`request message ${index} role must be a string`);
		const message = record as FauxOpenAIMessage;
		return message;
	});
}

/** Validate the complete OpenAI Chat Completions history sent to the faux provider. */
export function validateOpenAIChatHistory(messages: readonly FauxOpenAIMessage[]): void {
	if (messages.length === 0) throw new Error("provider history must not be empty");
	const calls = new Map<string, string>();
	const results = new Set<string>();
	let userCount = 0;
	for (const [index, message] of messages.entries()) {
		if (!message || typeof message !== "object") throw new Error(`history message ${index} must be an object`);
		switch (message.role) {
			case "system":
			case "developer":
			case "user":
				if (message.role === "user") userCount++;
				if (message.content === undefined) throw new Error(`history message ${index} is missing content`);
				break;
			case "assistant": {
				if (message.tool_calls !== undefined) {
					if (!Array.isArray(message.tool_calls))
						throw new Error(`history message ${index} tool_calls must be an array`);
					for (const [callIndex, call] of message.tool_calls.entries()) {
						const callObject = object(call, `history message ${index} tool call ${callIndex}`);
						if (callObject.type !== "function" || typeof callObject.id !== "string") {
							throw new Error(`history message ${index} tool call ${callIndex} is malformed`);
						}
						const functionObject = object(
							callObject.function,
							`history message ${index} tool call ${callIndex}.function`,
						);
						if (typeof functionObject.name !== "string" || typeof functionObject.arguments !== "string") {
							throw new Error(`history message ${index} tool call ${callIndex} has invalid function metadata`);
						}
						try {
							object(JSON.parse(functionObject.arguments), `history message ${index} tool call arguments`);
						} catch (error) {
							throw new Error(`history message ${index} tool call arguments are not JSON: ${String(error)}`);
						}
						if (calls.has(callObject.id)) throw new Error(`duplicate tool call id ${callObject.id}`);
						calls.set(callObject.id, functionObject.name);
					}
				}
				break;
			}
			case "tool": {
				if (typeof message.tool_call_id !== "string") {
					throw new Error(`history message ${index} tool result is missing call id`);
				}
				if (results.has(message.tool_call_id)) throw new Error(`duplicate tool result id ${message.tool_call_id}`);
				const toolName = calls.get(message.tool_call_id);
				if (toolName === undefined) throw new Error(`tool result ${message.tool_call_id} has no preceding call`);
				if (message.name !== undefined && message.name !== toolName) {
					throw new Error(`tool result ${message.tool_call_id} names ${message.name}, expected ${toolName}`);
				}
				if (message.content === undefined)
					throw new Error(`tool result ${message.tool_call_id} is missing content`);
				results.add(message.tool_call_id);
				break;
			}
			default:
				throw new Error(`unsupported provider history role ${String(message.role)}`);
		}
	}
	for (const [callId, toolName] of calls) {
		if (!results.has(callId)) throw new Error(`assistant tool call ${callId} (${toolName}) has no matching result`);
	}
	if (userCount === 0) throw new Error("provider history must contain a user message");
}

function completionBody(model: string): Record<string, unknown> {
	return {
		id: "faux-resume-completion",
		object: "chat.completion",
		created: 0,
		model,
		choices: [{ index: 0, message: { role: "assistant", content: "faux-resume-ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function streamBody(model: string): string {
	const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
		JSON.stringify({
			id: "faux-resume-stream",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return `data: ${chunk({ role: "assistant", content: "faux-resume-ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`;
}

export async function startFauxOpenAIProvider(
	options: { readonly expectedPrompt?: string } = {},
): Promise<FauxOpenAIProvider> {
	const requests: FauxOpenAIRequestRecord[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
				return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
			}
			let body: FauxOpenAIRequest | undefined;
			try {
				const parsed = object(await request.json(), "request");
				const messages = requestMessages(parsed.messages);
				if (typeof parsed.model !== "string") {
					throw new Error("request requires model and messages");
				}
				body = { ...parsed, model: parsed.model, messages };
				validateOpenAIChatHistory(body.messages);
				if (options.expectedPrompt !== undefined) {
					const last = body.messages.at(-1);
					if (last?.role !== "user" || !textContent(last.content).includes(options.expectedPrompt)) {
						throw new Error("request does not contain the expected follow-up prompt");
					}
				}
				requests.push({ request: body, valid: true });
			} catch (error) {
				if (body !== undefined) requests.push({ request: body, valid: false, error: String(error) });
				return new Response(JSON.stringify({ error: { message: String(error) } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}
			if (body === undefined) throw new Error("faux provider request was not parsed");
			if (body.stream === true) {
				return new Response(streamBody(body.model), { headers: { "content-type": "text/event-stream" } });
			}
			return new Response(JSON.stringify(completionBody(body.model)), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: async () => {
			await server.stop();
		},
	};
}
