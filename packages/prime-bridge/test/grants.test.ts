import { describe, expect, it } from "bun:test";
import {
	assertBridgeGrantsHaveSupervisor,
	BridgeGrantError,
	bridgeTokenDigest,
	grantAllowsSession,
	LEGACY_PRINCIPAL,
	parseBridgeGrants,
	serializeBridgeGrants,
} from "../src/grants";

const grantFile = (value: unknown): string => JSON.stringify(value);

describe("bridge grants", () => {
	it("reads a legacy bare token as one full-authority supervisor", () => {
		const grants = parseBridgeGrants("  00000000-0000-0000-0000-00000000000000000000-0000-0000-0000-000000000000\n");

		// Keyed by digest, never by the token itself.
		expect([...grants.keys()]).toEqual([
			bridgeTokenDigest("00000000-0000-0000-0000-00000000000000000000-0000-0000-0000-000000000000"),
		]);
		expect(
			grants.get(bridgeTokenDigest("00000000-0000-0000-0000-00000000000000000000-0000-0000-0000-000000000000")),
		).toEqual({
			principal: LEGACY_PRINCIPAL,
			role: "supervisor",
			sessions: [],
			capabilities: [],
		});
	});

	it("reads a grant file into per-token principals, roles, and session scope", () => {
		const grants = parseBridgeGrants(
			grantFile({
				"supervisor-token": { principal: "omp", role: "supervisor" },
				"worker-token": { principal: "cyboflow", role: "worker", sessions: ["sess-a", "sess-b"] },
			}),
		);

		expect(grants.get(bridgeTokenDigest("supervisor-token"))).toEqual({
			principal: "omp",
			role: "supervisor",
			sessions: [],
			capabilities: [],
		});
		expect(grants.get(bridgeTokenDigest("worker-token"))).toEqual({
			principal: "cyboflow",
			role: "worker",
			sessions: ["sess-a", "sess-b"],
			capabilities: [],
		});
	});

	it("scopes workers to granted sessions while supervisors reach every session", () => {
		const grants = parseBridgeGrants(
			grantFile({
				sup: { principal: "omp", role: "supervisor" },
				work: { principal: "cyboflow", role: "worker", sessions: ["sess-a"] },
			}),
		);
		const supervisor = grants.get(bridgeTokenDigest("sup"));
		const worker = grants.get(bridgeTokenDigest("work"));
		if (supervisor === undefined || worker === undefined) throw new Error("expected both grants");

		expect(grantAllowsSession(supervisor, "sess-a")).toBe(true);
		expect(grantAllowsSession(supervisor, "anything-else")).toBe(true);
		expect(grantAllowsSession(worker, "sess-a")).toBe(true);
		expect(grantAllowsSession(worker, "sess-b")).toBe(false);
	});

	it("fails closed on malformed grants instead of degrading to a permissive default", () => {
		const malformed: string[] = [
			"",
			"   ",
			// Non-JSON that is not the legacy bare-token shape is corruption, never a
			// supervisor — this is the fail-open the shape check closes.
			"not a legacy token",
			"truncated grant file {",
			"garbage content",
			"\n",
			grantFile({}),
			grantFile({ t: { principal: "omp" } }),
			grantFile({ t: { principal: "omp", role: "admin" } }),
			grantFile({ t: { principal: "", role: "worker" } }),
			grantFile({ t: { role: "worker" } }),
			grantFile({ t: { principal: "omp", role: "worker", sessions: "sess-a" } }),
			grantFile({ t: { principal: "omp", role: "worker", sessions: [""] } }),
			grantFile({ t: { principal: "omp", role: "worker", sessions: [1] } }),
			grantFile({ "": { principal: "omp", role: "supervisor" } }),
			grantFile({ t: null }),
			grantFile({ t: ["omp", "supervisor"] }),
			'"a-quoted-string-is-not-a-grant"',
			"42",
		];

		for (const contents of malformed) {
			expect(() => parseBridgeGrants(contents)).toThrow(BridgeGrantError);
		}
	});

	it("never echoes token or session values in grant errors", () => {
		const secretToken = "token-must-not-appear";
		const secretSession = "session-must-not-appear";
		let thrown: unknown;
		try {
			parseBridgeGrants(
				grantFile({ [secretToken]: { principal: "omp", role: "worker", sessions: [secretSession, 1] } }),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(BridgeGrantError);
		expect(String(thrown)).not.toContain(secretToken);
		expect(String(thrown)).not.toContain(secretSession);
	});

	it("rejects prototype-polluting tokens and grant keys", () => {
		expect(() => parseBridgeGrants('{"__proto__":{"principal":"omp","role":"supervisor"}}')).toThrow(
			BridgeGrantError,
		);
		expect(() =>
			parseBridgeGrants(grantFile({ t: { principal: "omp", role: "supervisor", constructor: "x" } })),
		).toThrow(BridgeGrantError);
		expect(Object.hasOwn(Object.prototype, "principal")).toBe(false);
	});

	it("rejects a grant file that defines no supervisor", () => {
		const workersOnly = parseBridgeGrants(
			grantFile({ w: { principal: "cyboflow", role: "worker", sessions: ["a"] } }),
		);

		expect(() => assertBridgeGrantsHaveSupervisor(workersOnly)).toThrow(BridgeGrantError);
	});

	it("stores no presentable credential on disk", () => {
		const grants = parseBridgeGrants(grantFile({ "secret-bearer-value": { principal: "omp", role: "supervisor" } }));

		// The point of digest keying: reading the file yields nothing usable as a bearer.
		expect(serializeBridgeGrants(grants)).not.toContain("secret-bearer-value");
		expect(grants.has("secret-bearer-value")).toBe(false);
		expect(grants.has(bridgeTokenDigest("secret-bearer-value"))).toBe(true);
	});
});
