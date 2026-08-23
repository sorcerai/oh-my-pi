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

	it("keeps local behavior when no external provider is configured", async () => {
		const result = await new HubTool(session()).execute("call", { op: "list" });
		expect(result.details?.externalPeers).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: "No other agents." });
	});

	it("does not expose external peers in a restricted session", async () => {
		const result = await new HubTool(session(provider(), { externalPeerProvider: undefined })).execute("call", {
			op: "list",
		});
		expect(result.details?.externalPeers).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: "No other agents." });
	});
});
