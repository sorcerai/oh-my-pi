import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGrantCommand } from "../src/grant-command";
import { bridgeTokenDigest, parseBridgeGrants } from "../src/grants";

const temporaryDirectories: string[] = [];

async function tokenFile(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-grant-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "token");
}

interface RunResult {
	code: number;
	out: string[];
	err: string[];
}

async function run(argv: string[]): Promise<RunResult> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runGrantCommand(argv, {
		writeOut: text => out.push(text),
		writeErr: text => err.push(text),
	});
	return { code, out, err };
}

const addWorker = (file: string, principal: string, ...sessions: string[]): string[] => [
	"grant",
	"add",
	"--principal",
	principal,
	"--role",
	"worker",
	...sessions.flatMap(session => ["--session", session]),
	"--token-file",
	file,
];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("grant command", () => {
	it("mints a worker token that parses back with its scope", async () => {
		const file = await tokenFile();

		const added = await run(addWorker(file, "cyboflow", "sess-a", "sess-b"));
		expect(added.code).toBe(0);
		const token = added.out[0];
		if (token === undefined) throw new Error("expected a minted token");

		const grants = parseBridgeGrants(await fs.readFile(file, "utf8"));
		expect(grants.get(bridgeTokenDigest(token))).toEqual({
			principal: "cyboflow",
			role: "worker",
			sessions: ["sess-a", "sess-b"],
		});
		expect(await fs.readFile(file, "utf8")).toContain("cyboflow");
		// The minted bearer must not be recoverable from the file it authorizes.
		expect(await fs.readFile(file, "utf8")).not.toContain(token);
	});

	it("writes the token file readable only by its owner", async () => {
		const file = await tokenFile();
		await run(addWorker(file, "cyboflow", "sess-a"));

		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	it("preserves an existing legacy bare token instead of clobbering it", async () => {
		const file = await tokenFile();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "legacy-token-still-in-use\n", { mode: 0o600 });

		await run(addWorker(file, "cyboflow", "sess-a"));

		// The running daemon and every existing pointer still hold this token; losing
		// it here would lock the operator out of their own bridge.
		const grants = parseBridgeGrants(await fs.readFile(file, "utf8"));
		expect(grants.get(bridgeTokenDigest("legacy-token-still-in-use"))?.role).toBe("supervisor");
		expect(grants.size).toBe(2);
	});

	it("never reveals a token again after minting", async () => {
		const file = await tokenFile();
		const added = await run(addWorker(file, "cyboflow", "sess-a"));
		const token = added.out[0];
		if (token === undefined) throw new Error("expected a minted token");

		const listed = await run(["grant", "list", "--token-file", file]);
		const jsonListed = await run(["grant", "list", "--json", "--token-file", file]);

		for (const line of [...listed.out, ...listed.err, ...jsonListed.out, ...jsonListed.err]) {
			expect(line).not.toContain(token);
		}
		expect(listed.out.join("\n")).toContain("cyboflow");
		expect(jsonListed.out.join("\n")).toContain("sha256:");
	});

	it("revokes every grant for a principal", async () => {
		const file = await tokenFile();
		await run(["grant", "add", "--principal", "omp", "--role", "supervisor", "--token-file", file]);
		await run(addWorker(file, "cyboflow", "sess-a"));
		await run(addWorker(file, "cyboflow", "sess-b"));

		expect((await run(["grant", "revoke", "--principal", "cyboflow", "--token-file", file])).code).toBe(0);

		const grants = parseBridgeGrants(await fs.readFile(file, "utf8"));
		expect([...grants.values()].map(grant => grant.principal)).toEqual(["omp"]);
	});

	it("refuses to revoke the last supervisor", async () => {
		const file = await tokenFile();
		await run(["grant", "add", "--principal", "omp", "--role", "supervisor", "--token-file", file]);
		await run(addWorker(file, "cyboflow", "sess-a"));

		await expect(run(["grant", "revoke", "--principal", "omp", "--token-file", file])).rejects.toThrow(
			/last supervisor/,
		);
	});

	it("rejects grants that cannot mean anything", async () => {
		const file = await tokenFile();

		// A worker with no sessions could reach nothing at all.
		await expect(run(["grant", "add", "--principal", "w", "--role", "worker", "--token-file", file])).rejects.toThrow(
			/--session is required/,
		);
		// Sessions on a supervisor imply a scope that is not enforced.
		await expect(
			run(["grant", "add", "--principal", "s", "--role", "supervisor", "--session", "sess-a", "--token-file", file]),
		).rejects.toThrow(/does not apply to a supervisor/);
		await expect(run(["grant", "add", "--principal", "x", "--role", "admin", "--token-file", file])).rejects.toThrow(
			/--role must be/,
		);
		await expect(run(["grant", "revoke", "--principal", "nobody", "--token-file", file])).rejects.toThrow(
			/no grant exists/,
		);
	});

	it("reports an empty token file rather than failing", async () => {
		const file = await tokenFile();

		const listed = await run(["grant", "list", "--token-file", file]);
		expect(listed.code).toBe(0);
		expect(listed.out.join("\n")).toContain("No grants");
	});
});
