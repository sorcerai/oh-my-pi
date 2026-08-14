/**
 * The four ADR re-opening proofs, as tests rather than a live-daemon spike.
 *
 * A spike proves the property once, on one machine, on one afternoon. These run
 * in CI, so the property cannot quietly stop being true — which is the specific
 * failure mode that produced this work: an authority claim asserted in prose and
 * tested by nothing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

const SUPERVISOR_TOKEN = "supervisor-token-value";
const WORKER_TOKEN = "worker-token-value";
const GRANTED_SESSION = "sess-granted";
const UNGRANTED_SESSION = "sess-ungranted";

/** Start a bridge whose token file grants one supervisor and one session-scoped worker. */
async function createServer(): Promise<PrimeBridgeServer> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-authority-"));
	temporaryDirectories.push(stateDir);
	const tokenFile = path.join(stateDir, "token");
	await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(
		tokenFile,
		JSON.stringify({
			[SUPERVISOR_TOKEN]: { principal: "omp", role: "supervisor" },
			[WORKER_TOKEN]: { principal: "cyboflow", role: "worker", sessions: [GRANTED_SESSION] },
		}),
		{ mode: 0o600 },
	);
	const config = resolveBridgeConfig({
		stateDir,
		tokenFile,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		port: 0,
	});
	const server = await startPrimeBridgeServer({ config, peers: () => [] });
	runningServers.push(server);
	return server;
}

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function mcp(server: PrimeBridgeServer, sessionId: string, token: string, extraHeaders: Record<string, string> = {}) {
	return fetch(`${server.url}/mcp/v1/sessions/${encodeURIComponent(sessionId)}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...extraHeaders,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

function v1(server: PrimeBridgeServer, route: string, token: string, init: RequestInit = {}) {
	return fetch(`${server.url}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
}

describe("bridge authority proofs", () => {
	it("proof 1: discovery is session-allowlisted", async () => {
		const server = await createServer();

		// The worker's own session is reachable; 404 only because no host has
		// registered it, which is a liveness answer rather than an authority one.
		expect((await mcp(server, GRANTED_SESSION, WORKER_TOKEN)).status).not.toBe(403);
		expect((await mcp(server, UNGRANTED_SESSION, WORKER_TOKEN)).status).toBe(403);
		// The supervisor is not session-scoped.
		expect((await mcp(server, UNGRANTED_SESSION, SUPERVISOR_TOKEN)).status).not.toBe(403);
	});

	it("proof 2: an unprivileged caller is refused on administrative routes", async () => {
		const server = await createServer();

		expect((await v1(server, "/v1/audit", WORKER_TOKEN)).status).toBe(403);
		expect(
			(
				await v1(server, "/v1/peers", WORKER_TOKEN, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: "s", projectRoot: "/tmp", harness: "omp" }),
				})
			).status,
		).toBe(403);
		expect((await v1(server, "/v1/audit", SUPERVISOR_TOKEN)).status).toBe(200);
	});

	it("proof 2b: tool-host registration requires a supervisor", async () => {
		const server = await createServer();

		// A worker cannot publish tools into sessions, so the upgrade is refused
		// before the WebSocket exists.
		const refused = await fetch(`${server.url}/v1/tool-host`, {
			headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
		});
		expect(refused.status).toBe(403);
	});

	it("proof 3: an unknown or absent credential never reaches a route", async () => {
		const server = await createServer();

		expect((await mcp(server, GRANTED_SESSION, "not-a-real-token")).status).toBe(401);
		expect((await fetch(`${server.url}/v1/audit`)).status).toBe(401);
		expect((await v1(server, "/v1/audit", "")).status).toBe(401);
		// Health is the one deliberate exception.
		expect((await fetch(`${server.url}/health`)).status).toBe(200);
	});

	it("proof 4: authority cannot be self-asserted", async () => {
		const server = await createServer();

		// Every plausible way a caller might try to name its own role. Authority is
		// read from the grant record only, so each stays a session-scoped worker.
		const forgedHeaders: Record<string, string>[] = [
			{ "x-principal": "omp" },
			{ "x-role": "supervisor" },
			{ role: "supervisor" },
			{ "x-omp-capability": "omp:supervise" },
		];
		for (const headers of forgedHeaders) {
			expect((await mcp(server, UNGRANTED_SESSION, WORKER_TOKEN, headers)).status).toBe(403);
			expect((await v1(server, "/v1/audit", WORKER_TOKEN, { headers })).status).toBe(403);
		}

		// Nor by naming a session it was not granted, however the path is encoded.
		for (const encoded of [UNGRANTED_SESSION, encodeURIComponent(UNGRANTED_SESSION)]) {
			const response = await fetch(`${server.url}/mcp/v1/sessions/${encoded}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
			expect(response.status).toBe(403);
		}
	});

	it("a legacy bare-token file still authenticates with full authority", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-legacy-"));
		temporaryDirectories.push(stateDir);
		const tokenFile = path.join(stateDir, "token");
		await fs.writeFile(tokenFile, "plain-legacy-token\n", { mode: 0o600 });
		const config = resolveBridgeConfig({
			stateDir,
			tokenFile,
			primeConfigFile: path.join(stateDir, "omp-bridge.json"),
			port: 0,
		});
		const server = await startPrimeBridgeServer({ config, peers: () => [] });
		runningServers.push(server);

		expect(server.token).toBe("plain-legacy-token");
		expect((await v1(server, "/v1/audit", "plain-legacy-token")).status).toBe(200);
		expect((await mcp(server, UNGRANTED_SESSION, "plain-legacy-token")).status).not.toBe(403);
	});
});

describe("mesh identity", () => {
	const message = (originSessionId: string) => ({
		meshMessageId: `mid-${originSessionId}`,
		idempotencyKey: `idem-${originSessionId}`,
		originSessionId,
		originHarness: "omp",
		targetHarness: "omp",
		targetId: "peer-x",
		body: "hello",
		projectRoot: "/tmp",
		createdAt: new Date(0).toISOString(),
	});

	const post = (server: PrimeBridgeServer, route: string, token: string, body: unknown) =>
		fetch(`${server.url}${route}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	it("refuses a worker that forges the sending session", async () => {
		const server = await createServer();

		expect((await post(server, "/v1/messages", WORKER_TOKEN, message(UNGRANTED_SESSION))).status).toBe(403);
		expect((await post(server, "/v1/messages", WORKER_TOKEN, message(GRANTED_SESSION))).status).not.toBe(403);
		// A supervisor is not session-scoped and may speak for any origin.
		expect((await post(server, "/v1/messages", SUPERVISOR_TOKEN, message(UNGRANTED_SESSION))).status).not.toBe(403);
	});

	it("refuses a worker that reads or drains another target's inbox", async () => {
		const server = await createServer();
		const inbox = (target: string, peek: string, token: string) =>
			v1(server, `/v1/inbox?targetId=${encodeURIComponent(target)}&peek=${peek}`, token);

		for (const peek of ["true", "false"]) {
			expect((await inbox(UNGRANTED_SESSION, peek, WORKER_TOKEN)).status).toBe(403);
			expect((await inbox(GRANTED_SESSION, peek, WORKER_TOKEN)).status).toBe(200);
			expect((await inbox(UNGRANTED_SESSION, peek, SUPERVISOR_TOKEN)).status).toBe(200);
		}
	});

	it("refuses a worker that waits on another target", async () => {
		const server = await createServer();
		// Only the refusal is asserted: a permitted /v1/wait parks until a message
		// arrives or its timeout elapses, so the positive case cannot be checked
		// without blocking the suite on it.
		const refused = await post(server, "/v1/wait", WORKER_TOKEN, { targetId: UNGRANTED_SESSION, timeoutMs: 0 });
		expect(refused.status).toBe(403);
	});
});
