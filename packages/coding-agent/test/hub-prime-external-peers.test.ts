import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import type { ExternalPeerProvider, ExternalPeerWaitClaim } from "../src/integrations/prime-bridge";

const settings = { get: (key: string) => (key === "irc.timeoutMs" ? 100 : undefined) } as never;

function bridgeMessage(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "prime",
		originSessionId: "prime-session",
		targetHarness: "omp",
		targetId: "omp-session",
		body: "hello",
		projectRoot: "/repo",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function waitClaim(message: BridgeMessage): ExternalPeerWaitClaim {
	return { message, claimToken: "claim-1", claimedUntilMs: Date.now() + 30_000 };
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	return Promise.withResolvers<T>();
}

function provider(overrides: Partial<ExternalPeerProvider> = {}): ExternalPeerProvider {
	return {
		list: async () => [],
		send: async () => ({ meshMessageId: "receipt-1", status: "queued" }),
		inbox: async () => [],
		wait: async () => null,
		ack: async () => true,
		release: async () => true,
		...overrides,
	};
}

function session(externalPeerProvider?: ExternalPeerProvider, overrides: Partial<ToolSession> = {}): ToolSession {
	const registry = AgentRegistry.global();
	registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session: null, status: "running" });
	return {
		cwd: "/repo",
		hasUI: false,
		settings,
		agentRegistry: registry,
		getAgentId: () => MAIN_AGENT_ID,
		getSessionFile: () => null,
		externalPeerProvider,
		...overrides,
	} as ToolSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("hub Prime external peers", () => {
	it("lists external peers with namespaced IDs and keeps local rows separate", async () => {
		const peer: ExternalPeer = {
			id: "prime-id",
			displayName: "Prime worker",
			status: "ready",
			activeSessionId: "session-1",
		};
		const result = await new HubTool(session(provider({ list: async () => [peer] }))).execute("call", { op: "list" });
		expect(result.details?.externalPeers).toEqual([{ ...peer, id: "prime://session-1" }]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("External Prime peers:") });
	});

	it("routes prime sends and preserves bridge receipts", async () => {
		let target = "";
		const receipt: BridgeReceipt = { meshMessageId: "receipt-1", status: "queued", extra: { keep: true } };
		const result = await new HubTool(
			session(
				provider({
					send: async value => {
						target = value;
						return receipt;
					},
				}),
			),
		).execute("call", { op: "send", to: "prime://session%2F1", message: "hello" });
		expect(target).toBe("session/1");
		expect(result.details?.externalReceipts).toEqual([receipt]);
	});

	it("races local and external waits and acknowledges the external winner", async () => {
		let acknowledged = "";
		const external = bridgeMessage({ body: "external winner" });
		const result = await new HubTool(
			session(
				provider({
					wait: async () => waitClaim(external),
					ack: async token => {
						acknowledged = token;
						return true;
					},
				}),
			),
		).execute("call", { op: "wait", timeoutMs: 100 });
		expect(result.details?.externalWaited).toEqual(external);
		expect(acknowledged).toBe("claim-1");
	});

	it("keeps a locally consumed message over an external claim in the message-only photo finish", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const external = bridgeMessage({ body: "external loser" });
		const wait = deferred<ExternalPeerWaitClaim | null>();
		let acknowledgements = 0;
		let releases = 0;
		const resultPromise = new HubTool(
			session(
				provider({
					wait: async () => wait.promise,
					ack: async () => {
						acknowledgements++;
						return true;
					},
					release: async () => {
						releases++;
						return true;
					},
				}),
			),
		).execute("call", { op: "wait", timeoutMs: 100 });

		wait.resolve(waitClaim(external));
		const localSend = deferred<void>();
		queueMicrotask(() => {
			void IrcBus.global()
				.send({ from: "Peer", to: MAIN_AGENT_ID, body: "local winner" })
				.then(() => localSend.resolve());
		});
		await localSend.promise;

		const result = await resultPromise;
		expect(result.details?.waited?.body).toBe("local winner");
		expect(result.details?.externalWaited).toBeUndefined();
		expect(acknowledgements).toBe(0);
		expect(releases).toBe(1);
	});
	it("keeps a locally consumed message over an external claim with watched jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = manager.register("bash", "wait forever", async () => new Promise<string>(() => {}), {
			ownerId: MAIN_AGENT_ID,
		});
		const external = bridgeMessage({ body: "external loser" });
		const wait = deferred<ExternalPeerWaitClaim | null>();
		let acknowledgements = 0;
		let releases = 0;
		const resultPromise = new HubTool(
			session(
				provider({
					wait: async () => wait.promise,
					ack: async () => {
						acknowledgements++;
						return true;
					},
					release: async () => {
						releases++;
						return true;
					},
				}),
				{ asyncJobManager: manager },
			),
		).execute("call", { op: "wait", timeoutMs: 100 });

		wait.resolve(waitClaim(external));
		const localSend = deferred<void>();
		queueMicrotask(() => {
			void IrcBus.global()
				.send({ from: "Peer", to: MAIN_AGENT_ID, body: "local winner" })
				.then(() => localSend.resolve());
		});
		await localSend.promise;

		const result = await resultPromise;
		expect(result.details?.waited?.body).toBe("local winner");
		expect(result.details?.externalWaited).toBeUndefined();
		expect(acknowledgements).toBe(0);
		expect(releases).toBe(1);
		manager.cancel(jobId);
	});

	it("preserves local list details when the external provider rejects with a sanitized error", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const result = await new HubTool(
			session(
				provider({
					list: async () => {
						throw new Error("provider unavailable\nretry later\u0000\u001b[31m");
					},
				}),
			),
		).execute("call", { op: "list" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["Peer"]);
		expect(text).toContain("1 peer(s)");
		expect(text).toContain("Prime external peer provider failed during list: provider unavailable retry later");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("\u001b");
	});

	it("preserves local list details when external peer normalization fails", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const result = await new HubTool(
			session(
				provider({
					list: async () => [{ id: "\ud800", displayName: "Malformed", status: "ready" }],
				}),
			),
		).execute("call", { op: "list" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["Peer"]);
		expect(text).toContain("1 peer(s)");
		expect(text).toContain(
			"Prime external peer provider failed during list: Prime peer ID must be well-formed Unicode",
		);
	});

	it("preserves local inbox details when the external provider rejects with a sanitized error", async () => {
		const toolSession = session(
			provider({
				inbox: async () => {
					throw new Error("inbox unavailable\r\nplease retry\u0000\u001b[2m");
				},
			}),
		);
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: {
				deliverIrcMessage: async () => {
					throw new Error("buffer for inbox");
				},
			} as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		await IrcBus.global().send({ from: "Peer", to: MAIN_AGENT_ID, body: "local inbox message" });

		const result = await new HubTool(toolSession).execute("call", { op: "inbox" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(result.details?.inbox?.map(message => message.body)).toEqual(["local inbox message"]);
		expect(text).toContain("1 message(s):");
		expect(text).toContain("Prime external peer provider failed during inbox: inbox unavailable please retry");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("\u001b");
	});

	it("keeps local behavior when no external provider is configured", async () => {
		const result = await new HubTool(session()).execute("call", { op: "list" });
		expect(result.details?.externalPeers).toBeUndefined();
		expect(result.content[0]).toEqual({
			type: "text",
			text: "No other agents (running 0, idle 0, parked 0; shown 0, truncated 0).",
		});
	});

	it("does not expose external peers in a restricted session", async () => {
		const result = await new HubTool(session(provider(), { externalPeerProvider: undefined })).execute("call", {
			op: "list",
		});
		expect(result.details?.externalPeers).toBeUndefined();
		expect(result.content[0]).toEqual({
			type: "text",
			text: "No other agents (running 0, idle 0, parked 0; shown 0, truncated 0).",
		});
	});
});
