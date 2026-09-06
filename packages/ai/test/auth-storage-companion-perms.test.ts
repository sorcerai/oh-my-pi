/**
 * SQLite stamps a newly created `-wal`/`-shm` with the database file's mode.
 * On a first run the database is created under the process umask (0644 with the
 * common 022) and only chmod'd to 0600 afterwards, so the companions keep the
 * looser mode. `-shm` then survives later opens and stays world-readable, which
 * makes the Prime importer refuse the destination as an unsafe credential
 * companion. `open()` normalizes the whole set so such an install heals itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

describe("credential database companion permissions", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-companion-perms-"));
		await fs.chmod(dir, 0o700);
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	const mode = async (target: string): Promise<number> => (await fs.stat(target)).mode & 0o777;

	test("open() restricts the database and its companions to 0600", async () => {
		const dbPath = path.join(dir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveApiKey("openai", "test-key");

		expect(await mode(dbPath)).toBe(0o600);
		for (const companion of [`${dbPath}-wal`, `${dbPath}-shm`]) {
			// Only assert on companions SQLite actually left behind.
			const present = await fs
				.stat(companion)
				.then(() => true)
				.catch(() => false);
			if (present) expect(await mode(companion)).toBe(0o600);
		}
	});

	test("open() heals companions left world-readable by an earlier run", async () => {
		const dbPath = path.join(dir, "agent.db");
		const first = await SqliteAuthCredentialStore.open(dbPath);
		first.saveApiKey("openai", "test-key");

		// Reproduce the first-run artifact: companions created before the chmod.
		const loosened: string[] = [];
		for (const companion of [`${dbPath}-wal`, `${dbPath}-shm`]) {
			try {
				await fs.chmod(companion, 0o644);
				loosened.push(companion);
			} catch {
				// Companion absent on this platform/run.
			}
		}
		expect(loosened.length).toBeGreaterThan(0);

		await SqliteAuthCredentialStore.open(dbPath);
		for (const companion of loosened) expect(await mode(companion)).toBe(0o600);
	});
});
