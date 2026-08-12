import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionHarness } from "./report";

export const SESSION_MANIFEST_VERSION = 1 as const;
export const SESSION_MANIFEST_FILENAME = ".omp-prime-bridge-session.json" as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface SessionManifest {
	readonly version: typeof SESSION_MANIFEST_VERSION;
	readonly harness: SessionHarness;
	readonly nativePath: string;
	readonly nativeDigest: string;
	readonly bridgeDigest: string;
	readonly casPath: string;
}

export interface SessionManifestMatch {
	readonly manifest: SessionManifest;
	readonly manifestPath: string;
	readonly root: string;
	readonly casRoot: string;
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value))
		throw new Error(`Session manifest ${field} must be a non-empty relative path`);
	const normalized = path.normalize(value);
	if (normalized !== value || value === "." || value === ".." || value.startsWith(`..${path.sep}`))
		throw new Error(`Session manifest ${field} must stay within its destination`);
}

function parseManifest(value: unknown): SessionManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Session manifest must be an object");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const expected = ["bridgeDigest", "casPath", "harness", "nativeDigest", "nativePath", "version"];
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
		throw new Error("Session manifest has unexpected fields");
	if (record.version !== SESSION_MANIFEST_VERSION) throw new Error("Session manifest has an unsupported version");
	if (record.harness !== "prime" && record.harness !== "omp")
		throw new Error("Session manifest has an invalid harness");
	if (typeof record.nativeDigest !== "string" || !SHA256_HEX.test(record.nativeDigest))
		throw new Error("Session manifest has an invalid nativeDigest");
	if (typeof record.bridgeDigest !== "string" || !SHA256_HEX.test(record.bridgeDigest))
		throw new Error("Session manifest has an invalid bridgeDigest");
	const nativePath = record.nativePath;
	const casPath = record.casPath;
	assertRelativePath(nativePath, "nativePath");
	assertRelativePath(casPath, "casPath");
	return {
		version: SESSION_MANIFEST_VERSION,
		harness: record.harness,
		nativePath,
		nativeDigest: record.nativeDigest,
		bridgeDigest: record.bridgeDigest,
		casPath,
	};
}

export function createSessionManifest(input: Omit<SessionManifest, "version">): SessionManifest {
	return parseManifest({ version: SESSION_MANIFEST_VERSION, ...input });
}

export async function writeSessionManifest(root: string, manifest: SessionManifest): Promise<string> {
	const manifestPath = path.join(root, SESSION_MANIFEST_FILENAME);
	const handle = await fs.open(manifestPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return manifestPath;
}

export async function findSessionManifest(nativePath: string): Promise<SessionManifestMatch | undefined> {
	const resolvedNativePath = path.resolve(nativePath);
	let directory = path.dirname(resolvedNativePath);
	for (;;) {
		const manifestPath = path.join(directory, SESSION_MANIFEST_FILENAME);
		let manifestText: string | undefined;
		try {
			manifestText = await fs.readFile(manifestPath, "utf8");
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		if (manifestText !== undefined) {
			const parsed = parseManifest(JSON.parse(manifestText));
			const expectedNativePath = path.resolve(directory, parsed.nativePath);
			if (expectedNativePath === resolvedNativePath) {
				const casRoot = path.resolve(directory, parsed.casPath);
				const [canonicalRoot, canonicalCasRoot] = await Promise.all([fs.realpath(directory), fs.realpath(casRoot)]);
				const relativeCas = path.relative(canonicalRoot, canonicalCasRoot);
				if (relativeCas === ".." || relativeCas.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCas))
					throw new Error("Session manifest casPath must stay within its destination");
				return { manifest: parsed, manifestPath, root: directory, casRoot: canonicalCasRoot };
			}
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function manifestDigestMatches(manifest: SessionManifest, nativeDigest: string): boolean {
	return SHA256_HEX.test(nativeDigest) && manifest.nativeDigest === nativeDigest;
}
