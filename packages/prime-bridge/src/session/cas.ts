import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CasRef } from "./spec";

const SHA256_HEX = /^[0-9a-f]{64}$/;
export interface FileCasFileSystem {
	mkdir(directory: string): Promise<void>;
	open(
		filePath: string,
		flags: "r" | "wx",
		mode?: number,
	): Promise<{
		writeFile(bytes: Uint8Array): Promise<void>;
		sync(): Promise<void>;
		close(): Promise<void>;
	}>;
	link(source: string, destination: string): Promise<void>;
	unlink(filePath: string): Promise<void>;
}

const defaultFileSystem: FileCasFileSystem = {
	mkdir: async directory => {
		await fs.mkdir(directory, { recursive: true });
	},
	open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
	link: fs.link,
	unlink: fs.unlink,
};

export class CasBlobUnavailableError extends Error {
	constructor(hash: string) {
		super(`CAS blob unavailable: ${hash}`);
		this.name = "CasBlobUnavailableError";
	}
}

export class CasCorruptionError extends Error {
	constructor(hash: string) {
		super(`CAS hash verification failed for ${hash}`);
		this.name = "CasCorruptionError";
	}
}

export class FileCas {
	readonly root: string;
	readonly casRoot: string;
	#fileSystem: FileCasFileSystem;

	constructor(stateRoot: string, fileSystem: FileCasFileSystem = defaultFileSystem) {
		this.root = stateRoot;
		this.casRoot = path.join(stateRoot, "cas", "sha256");
		this.#fileSystem = fileSystem;
	}

	pathFor(hash: string): string {
		if (!SHA256_HEX.test(hash)) throw new Error("CAS hash must be a lowercase SHA-256 hash");
		return path.join(this.casRoot, hash.slice(0, 2), hash);
	}

	async put(bytes: Uint8Array): Promise<CasRef> {
		const hash = FileCas.hash(bytes);
		const blobPath = this.pathFor(hash);
		if (await Bun.file(blobPath).exists()) {
			const existing = await this.#readAndSync(hash, blobPath);
			return { hash, byteLength: existing.byteLength };
		}
		await this.#fileSystem.mkdir(path.dirname(blobPath));
		const tempPath = `${blobPath}.${crypto.randomUUID()}.tmp`;
		try {
			const tempHandle = await this.#fileSystem.open(tempPath, "wx", 0o600);
			try {
				await tempHandle.writeFile(bytes);
				await tempHandle.sync();
			} finally {
				await tempHandle.close();
			}
			try {
				await this.#fileSystem.link(tempPath, blobPath);
			} catch (error) {
				if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") {
					throw error;
				}
			}
		} finally {
			await this.#fileSystem.unlink(tempPath).catch(() => undefined);
		}
		const published = await this.#readAndSync(hash, blobPath);
		return { hash, byteLength: published.byteLength };
	}

	async #readAndSync(hash: string, blobPath: string): Promise<Uint8Array> {
		const published = await this.read({ hash });
		await this.#sync(blobPath);
		await this.#sync(path.dirname(blobPath));
		return published;
	}

	async #sync(filePath: string): Promise<void> {
		const handle = await this.#fileSystem.open(filePath, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async read(ref: CasRef | string): Promise<Uint8Array> {
		const hash = typeof ref === "string" ? ref : ref.hash;
		const blobPath = this.pathFor(hash);
		if (!(await Bun.file(blobPath).exists())) throw new CasBlobUnavailableError(hash);
		const bytes = new Uint8Array(await Bun.file(blobPath).arrayBuffer());
		if (FileCas.hash(bytes) !== hash) throw new CasCorruptionError(hash);
		if (typeof ref !== "string" && ref.byteLength !== undefined && ref.byteLength !== bytes.byteLength) {
			throw new CasCorruptionError(hash);
		}
		return bytes;
	}

	async get(ref: CasRef | string): Promise<Uint8Array | undefined> {
		const hash = typeof ref === "string" ? ref : ref.hash;
		if (!(await Bun.file(this.pathFor(hash)).exists())) return undefined;
		return this.read(ref);
	}

	async has(ref: CasRef | string): Promise<boolean> {
		const hash = typeof ref === "string" ? ref : ref.hash;
		return Bun.file(this.pathFor(hash)).exists();
	}

	static hash(bytes: Uint8Array): string {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(bytes);
		return hasher.digest("hex");
	}
}

export { FileCas as ContentAddressedStore, FileCas as SessionCas };
