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
	it("applies status filtering to local and Prime peer rows", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "LocalIdle",
			displayName: "Local idle",
			kind: "sub",
			session: { isStreaming: false } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "idle",
		});
		const result = await new HubTool(
			session(
				provider({
					list: async () => [
						{ id: "prime-ready", displayName: "Prime ready", status: "ready", activeSessionId: "ready" },
						{ id: "prime-idle", displayName: "Prime idle", status: "idle", activeSessionId: "idle" },
						{ id: "prime-active", displayName: "Prime active", status: "active", activeSessionId: "active" },
					],
				}),
			),
		).execute("call", { op: "list", status: "idle" });
		expect(result.details?.externalPeers?.map(peer => peer.id)).toEqual(["prime://idle"]);
		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["LocalIdle"]);
	});

	it("hides parked Prime peers by default while retaining full roster counts", async () => {
		const tool = new HubTool(
			session(
				provider({
					list: async () => [
						{ id: "running", displayName: "Running", status: "ready" },
						{ id: "idle", displayName: "Idle", status: "idle" },
						{ id: "parked", displayName: "Parked", status: "parked" },
						{ id: "unknown", displayName: "Unknown", status: "unknown" },
					],
				}),
			),
		);
		const active = await tool.execute("active", { op: "list" });
		expect(active.details?.externalPeers?.map(peer => peer.id)).toEqual(["prime://running", "prime://idle"]);
		expect(active.details?.counts).toMatchObject({ running: 1, idle: 1, parked: 1, shown: 2 });
		const parked = await tool.execute("parked", { op: "list", status: "parked" });
		expect(parked.details?.externalPeers?.map(peer => peer.id)).toEqual(["prime://parked"]);
		expect(parked.details?.counts).toMatchObject({ running: 1, idle: 1, parked: 1, shown: 1 });
	});

	it("applies one capacity bound across local and Prime peer rows", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "LocalRunning",
			displayName: "Local running",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const result = await new HubTool(
			session(
				provider({
					list: async () => [
						{ id: "prime-1", displayName: "Prime 1", status: "ready", activeSessionId: "prime-1" },
						{ id: "prime-2", displayName: "Prime 2", status: "idle", activeSessionId: "prime-2" },
						{ id: "prime-3", displayName: "Prime 3", status: "active", activeSessionId: "prime-3" },
					],
				}),
			),
		).execute("call", { op: "list", limit: 2 });
		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["LocalRunning"]);
		expect(result.details?.externalPeers?.map(peer => peer.id)).toEqual(["prime://prime-1"]);
		expect(result.details?.counts).toMatchObject({ shown: 2, truncated: 2 });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("truncated") });
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
		).execute("call", { op: "wait" });
		expect(result.details?.externalWaited).toEqual(external);
		expect(acknowledged).toBe("claim-1");
	});

	it.each([false, true])(
		"returns the committed message when cancellation arrives during ACK (watched jobs: %s)",
		async watchedJobs => {
			const controller = new AbortController();
			const external = bridgeMessage({ body: "committed delivery" });
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const jobId = watchedJobs
				? manager.register("bash", "pending job", async () => Promise.withResolvers<string>().promise, {
						ownerId: MAIN_AGENT_ID,
					})
				: undefined;
			let releases = 0;
			try {
				const result = await new HubTool(
					session(
						provider({
							wait: async () => waitClaim(external),
							ack: async () => {
								controller.abort();
								return true;
							},
							release: async () => {
								releases++;
								return true;
							},
						}),
						{ asyncJobManager: manager },
					),
				).execute("call", { op: "wait", ...(jobId ? { ids: [jobId] } : {}) }, controller.signal);
				expect(result.details?.externalWaited).toEqual(external);
				expect(releases).toBe(0);
			} finally {
				if (jobId) manager.cancel(jobId);
			}
		},
	);

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
		).execute("call", { op: "wait" });

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
	it("releases an external claim when the caller aborts during message photo-finish cleanup", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: { isStreaming: true } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
			status: "running",
		});
		const controller = new AbortController();
		const abortReason = new Error("photo-finish aborted");
		const external = bridgeMessage();
		Object.defineProperty(external, "body", {
			get() {
				controller.abort(abortReason);
				return "external message";
			},
		});
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
		).execute("call", { op: "wait" }, controller.signal);

		wait.resolve(waitClaim(external));
		await expect(resultPromise).rejects.toThrow(abortReason);
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
		const jobId = manager.register("bash", "wait forever", async () => Promise.withResolvers<string>().promise, {
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
		).execute("call", { op: "wait" });

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
	it("releases an external claim when a watched-job wait aborts before acknowledgement", async () => {
		const controller = new AbortController();
		const abortReason = new Error("watched-job aborted");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = manager.register("bash", "wait forever", async () => Promise.withResolvers<string>().promise, {
			ownerId: MAIN_AGENT_ID,
		});
		const external = bridgeMessage();
		Object.defineProperty(external, "body", {
			get() {
				controller.abort(abortReason);
				return "external message";
			},
		});
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
		).execute("call", { op: "wait" }, controller.signal);

		wait.resolve(waitClaim(external));
		await expect(resultPromise).rejects.toThrow(abortReason);
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
		expect(text).toContain("provider unavailable retry later");
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
		expect(text).toContain("well-formed Unicode");
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
		expect(text).toContain("inbox unavailable please retry");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("\u001b");
	});

	it("keeps local behavior when no external provider is configured", async () => {
		const toolSession = session();
		AgentRegistry.global().register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: null,
			status: "idle",
		});
		const result = await new HubTool(toolSession).execute("call", { op: "list" });
		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["Peer"]);
		expect(result.details?.externalPeers).toBeUndefined();
	});
});
