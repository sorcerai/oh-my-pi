import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { SessionManager, type SessionTreeImportNode } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class RejectingPublishStorage extends FileSessionStorage {
	publishedDestination: string | undefined;
	stagedContent: string | undefined;

	override async publishCreateOnly(source: string, destination: string): Promise<void> {
		this.stagedContent = await Bun.file(source).text();
		await fs.link(source, destination);
		this.publishedDestination = destination;
		throw new Error("publication rejected");
	}
}

describe("SessionManager.importTree", () => {
	it("rejects a disconnected cycle before compaction ancestry validation can loop", async () => {
		const nodes: SessionTreeImportNode[] = [
			{
				sourceId: "root",
				parentSourceId: null,
				entry: { type: "custom", customType: "root", data: {} },
			},
			{
				sourceId: "cycle-a",
				parentSourceId: "cycle-b",
				entry: { type: "custom", customType: "cycle-a", data: {} },
			},
			{
				sourceId: "cycle-b",
				parentSourceId: "cycle-a",
				entry: {
					type: "compaction",
					summary: "disconnected cycle",
					firstKeptEntryId: "root",
					tokensBefore: 1,
				},
			},
		];

		await expect(SessionManager.importTree("/cwd", nodes, "root")).rejects.toThrow(/unreachable|cyclic/i);
	});
	it("does not salvage a rejected publication when a raced destination has identical bytes", async () => {
		const storage = new RejectingPublishStorage();
		const sessionDir = await fs.mkdtemp("/tmp/omp-session-import-");
		try {
			const nodes: SessionTreeImportNode[] = [
				{
					sourceId: "root",
					parentSourceId: null,
					entry: { type: "custom", customType: "root", data: {} },
				},
			];

			await expect(SessionManager.importTree("/cwd", nodes, "root", { sessionDir, storage })).rejects.toThrow(
				"publication rejected",
			);

			const publishedDestination = storage.publishedDestination;
			const stagedContent = storage.stagedContent;
			expect(publishedDestination).toBeDefined();
			expect(stagedContent).toBeDefined();
			if (publishedDestination === undefined || stagedContent === undefined)
				throw new Error("missing publish evidence");
			expect(await Bun.file(publishedDestination).text()).toBe(stagedContent);
		} finally {
			await fs.rm(sessionDir, { recursive: true, force: true });
		}
	});
});
