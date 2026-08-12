import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas, type FileCasFileSystem } from "../src/session/cas";

const temporaryDirectories: string[] = [];

function trackingFileSystem(blobPath: string, events: string[]): FileCasFileSystem {
	const directory = path.dirname(blobPath);
	const label = (filePath: string): string => {
		if (filePath === blobPath) return "blob";
		if (filePath === directory) return "directory";
		if (filePath.startsWith(`${blobPath}.`) && filePath.endsWith(".tmp")) return "temp";
		return filePath;
	};

	return {
		mkdir: async filePath => {
			events.push(`mkdir:${label(filePath)}`);
			await fs.mkdir(filePath, { recursive: true });
		},
		open: async (filePath, flags, mode) => {
			events.push(`open:${label(filePath)}:${flags}`);
			const handle = await fs.open(filePath, flags, mode);
			return {
				writeFile: async bytes => {
					events.push(`write:${label(filePath)}`);
					await handle.writeFile(bytes);
				},
				sync: async () => {
					events.push(`sync:${label(filePath)}`);
					await handle.sync();
				},
				close: async () => {
					events.push(`close:${label(filePath)}`);
					await handle.close();
				},
			};
		},
		link: async (source, destination) => {
			events.push(`link:${label(source)}:${label(destination)}`);
			await fs.link(source, destination);
		},
		unlink: async filePath => {
			events.push(`unlink:${label(filePath)}`);
			await fs.unlink(filePath);
		},
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("filesystem session CAS durability", () => {
	it("syncs completed bytes before create-only publication and syncs the containing directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-durability-"));
		temporaryDirectories.push(root);
		const bytes = new TextEncoder().encode("durable");
		const blobPath = new FileCas(root).pathFor(FileCas.hash(bytes));
		const events: string[] = [];
		const cas = new FileCas(root, trackingFileSystem(blobPath, events));

		const ref = await cas.put(bytes);

		expect(await cas.read(ref)).toEqual(bytes);
		expect(events).toEqual([
			"mkdir:directory",
			"open:temp:wx",
			"write:temp",
			"sync:temp",
			"close:temp",
			"link:temp:blob",
			"unlink:temp",
			"open:blob:r",
			"sync:blob",
			"close:blob",
			"open:directory:r",
			"sync:directory",
			"close:directory",
		]);
	});

	it("syncs a verified existing blob and its containing directory without replacing it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-idempotent-"));
		temporaryDirectories.push(root);
		const bytes = new TextEncoder().encode("existing");
		const blobPath = new FileCas(root).pathFor(FileCas.hash(bytes));
		await fs.mkdir(path.dirname(blobPath), { recursive: true });
		await Bun.write(blobPath, bytes);
		const events: string[] = [];
		const cas = new FileCas(root, trackingFileSystem(blobPath, events));

		const ref = await cas.put(bytes);

		expect(ref).toEqual({ hash: FileCas.hash(bytes), byteLength: bytes.byteLength });
		expect(events).toEqual([
			"open:blob:r",
			"sync:blob",
			"close:blob",
			"open:directory:r",
			"sync:directory",
			"close:directory",
		]);
	});
});
