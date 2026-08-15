import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { type PrimeBridgeConfig, resolveBridgeConfig } from "./config";
import {
	type BridgeGrant,
	BridgeGrantError,
	type BridgeRole,
	parseBridgeGrants,
	serializeBridgeGrants,
	withBridgeGrant,
	withoutBridgePrincipal,
} from "./grants";
import { writeSecretFile } from "./token";

export interface GrantCommandIo {
	writeOut(text: string): void;
	writeErr(text: string): void;
}

const USAGE = [
	"Usage:",
	"  grant add --principal <name> --role supervisor|worker [--session <id>]... [--token-file <path>]",
	"  grant list [--json] [--token-file <path>]",
	"  grant revoke --principal <name> [--token-file <path>]",
].join("\n");

/** Stable, non-reversible handle for a token, safe to display. */
function tokenIdentifier(token: string): string {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)}`;
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
	const config = resolveConfig(argv);

	if (operation === "add") {
		const principal = optionValue(argv, "--principal");
		if (principal === undefined || principal.length === 0) throw new Error("--principal is required");
		const role = parseRole(optionValue(argv, "--role"));
		const sessions = optionValues(argv, "--session");
		if (role === "worker" && sessions.length === 0)
			throw new Error("--session is required at least once for a worker grant");
		if (role === "supervisor" && sessions.length > 0)
			throw new Error("--session does not apply to a supervisor, which reaches every session");

		const token = `${randomUUID()}${randomUUID()}`;
		const grants = withBridgeGrant(await readGrants(config.tokenFile), token, { principal, role, sessions });
		await writeSecretFile(config.tokenFile, serializeBridgeGrants(grants));
		io.writeOut(token);
		io.writeErr(
			`Granted ${role} "${principal}" (${tokenIdentifier(token)}) in ${config.tokenFile}.\n` +
				"The token above is shown once and is not recoverable.",
		);
		return 0;
	}

	if (operation === "list") {
		const grants = await readGrants(config.tokenFile);
		const rows = [...grants].map(([token, grant]) => ({
			principal: grant.principal,
			role: grant.role,
			sessions: grant.sessions,
			token: tokenIdentifier(token),
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
		if (principal === undefined || principal.length === 0) throw new Error("--principal is required");
		const grants = withoutBridgePrincipal(await readGrants(config.tokenFile), principal);
		await writeSecretFile(config.tokenFile, serializeBridgeGrants(grants));
		io.writeErr(`Revoked every grant for "${principal}" in ${config.tokenFile}.`);
		return 0;
	}

	throw new Error(USAGE);
}

export { BridgeGrantError };
