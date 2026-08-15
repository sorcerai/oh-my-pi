import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { type PrimeBridgeConfig, resolveBridgeConfig } from "./config";
import {
	type BridgeGrant,
	BridgeGrantError,
	type BridgeRole,
	bridgeTokenDigest,
	parseBridgeGrants,
	serializeBridgeGrants,
	withBridgeGrant,
	withoutBridgeGrantHandle,
	withoutBridgePrincipal,
} from "./grants";
import { writeSecretFile } from "./token";

export interface GrantCommandIo {
	writeOut(text: string): void;
	writeErr(text: string): void;
}

const DISPLAY_HANDLE_LENGTH = "sha256:".length + 16;

const USAGE = [
	"Usage:",
	"  grant add --principal <name> --role supervisor|worker [--session <id>]... [--capability <name>]... [--token-file <path>]",
	"  grant list [--json] [--token-file <path>]",
	"  grant revoke (--principal <name> | --token <handle>) [--token-file <path>]",
].join("\n");

/**
 * Short, displayable handle for a grant, derived from its digest key.
 *
 * This must truncate the key itself rather than re-hash it: grants are keyed by
 * digest, so hashing the key again yields a digest-of-a-digest that identifies
 * no grant and cannot be used to revoke one.
 */
function grantHandle(digest: string): string {
	return digest.slice(0, DISPLAY_HANDLE_LENGTH);
}

function optionValue(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function optionValues(argv: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let index = argv.indexOf(name); index >= 0; index = argv.indexOf(name, index + 1)) {
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
		values.push(value);
	}
	return values;
}

function parseRole(value: string | undefined): BridgeRole {
	if (value === "supervisor" || value === "worker") return value;
	throw new Error('--role must be "supervisor" or "worker"');
}

/** Flags each operation accepts, and whether the flag consumes the next argument. */
const OPERATION_FLAGS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
	add: { "--principal": true, "--role": true, "--session": true, "--capability": true, "--token-file": true },
	list: { "--json": false, "--token-file": true },
	revoke: { "--principal": true, "--token": true, "--token-file": true },
};

/**
 * Reject any argument the operation does not define.
 *
 * A silently ignored flag is worse than a rejected one here: `--capabilty` or
 * `--sesion` would mint a grant missing that authority while reporting success,
 * so the operator believes they issued something they did not.
 */
function assertKnownFlags(argv: readonly string[], operation: string): void {
	const flags = OPERATION_FLAGS[operation];
	if (flags === undefined) throw new Error(USAGE);
	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) continue;
		const takesValue = flags[argument];
		if (takesValue === undefined) throw new Error(`unknown option "${argument}" for grant ${operation}\n${USAGE}`);
		if (takesValue) index += 1;
	}
}

/**
 * Read the current grants, treating an absent file as empty.
 *
 * A legacy bare-token file parses as one full-authority supervisor, so adding the
 * first real grant preserves the existing token rather than locking out whatever
 * is already using it.
 */
async function readGrants(tokenFile: string): Promise<ReadonlyMap<string, BridgeGrant>> {
	let contents: string;
	try {
		contents = await fs.readFile(tokenFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	return parseBridgeGrants(contents);
}

function resolveConfig(argv: readonly string[]): PrimeBridgeConfig {
	const tokenFile = optionValue(argv, "--token-file");
	return resolveBridgeConfig(tokenFile === undefined ? {} : { tokenFile });
}

/**
 * Run `omp-prime-bridge grant ...`.
 *
 * A minted token is printed exactly once, at creation. It is never recoverable
 * from `list`, which shows only the principal, role, sessions, and a hash handle.
 */
export async function runGrantCommand(argv: readonly string[], io: GrantCommandIo): Promise<number> {
	if (argv[0] !== "grant") throw new Error("Expected grant command");
	const operation = argv[1];
	if (operation === undefined) throw new Error(USAGE);
	assertKnownFlags(argv, operation);
	const config = resolveConfig(argv);

	if (operation === "add") {
		const principal = optionValue(argv, "--principal");
		if (principal === undefined || principal.length === 0) throw new Error("--principal is required");
		const role = parseRole(optionValue(argv, "--role"));
		const sessions = optionValues(argv, "--session");
		const capabilities = optionValues(argv, "--capability");
		if (role === "worker" && sessions.length === 0)
			throw new Error("--session is required at least once for a worker grant");
		if (role === "supervisor" && sessions.length > 0)
			throw new Error("--session does not apply to a supervisor, which reaches every session");
		if (role === "supervisor" && capabilities.length > 0)
			throw new Error("--capability does not apply to a supervisor, which holds every capability");

		const token = `${randomUUID()}${randomUUID()}`;
		const grants = withBridgeGrant(await readGrants(config.tokenFile), token, {
			principal,
			role,
			sessions,
			capabilities,
		});
		await writeSecretFile(config.tokenFile, serializeBridgeGrants(grants));
		io.writeOut(token);
		io.writeErr(
			`Granted ${role} "${principal}" (${grantHandle(bridgeTokenDigest(token))}) in ${config.tokenFile}.\n` +
				"The token above is shown once and is not recoverable.",
		);
		return 0;
	}

	if (operation === "list") {
		const grants = await readGrants(config.tokenFile);
		const rows = [...grants].map(([digest, grant]) => ({
			principal: grant.principal,
			role: grant.role,
			sessions: grant.sessions,
			capabilities: grant.capabilities,
			token: grantHandle(digest),
		}));
		if (argv.includes("--json")) {
			io.writeOut(JSON.stringify(rows, null, 2));
			return 0;
		}
		if (rows.length === 0) {
			io.writeOut(`No grants in ${config.tokenFile}.`);
			return 0;
		}
		for (const row of rows) {
			const scope = row.role === "supervisor" ? "all sessions" : row.sessions.join(", ") || "no sessions";
			io.writeOut(`${row.principal}\t${row.role}\t${scope}\t${row.token}`);
		}
		return 0;
	}

	if (operation === "revoke") {
		const principal = optionValue(argv, "--principal");
		const handle = optionValue(argv, "--token");
		if (principal !== undefined && handle !== undefined)
			throw new Error("pass either --principal or --token, not both");

		// Revoking by handle retires one grant. A principal that holds several
		// scoped tokens — the intended shape for a worker — would otherwise have to
		// lose all of them and be re-minted to retire any one.
		if (handle !== undefined) {
			const grants = await readGrants(config.tokenFile);
			const remaining = withoutBridgeGrantHandle(grants, handle);
			await writeSecretFile(config.tokenFile, serializeBridgeGrants(remaining));
			io.writeErr(`Revoked grant ${handle} in ${config.tokenFile}.`);
			return 0;
		}

		if (principal === undefined || principal.length === 0) throw new Error("--principal or --token is required");
		const grants = withoutBridgePrincipal(await readGrants(config.tokenFile), principal);
		await writeSecretFile(config.tokenFile, serializeBridgeGrants(grants));
		io.writeErr(`Revoked every grant for "${principal}" in ${config.tokenFile}.`);
		return 0;
	}

	throw new Error(USAGE);
}

export { BridgeGrantError };
