import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeMessage, BridgeReceipt, PrimeDaemonCursor } from "@oh-my-pi/prime-bridge-protocol";
import { BridgeStore } from "../src";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-store-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "bridge.sqlite");
}

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "omp",
		originSessionId: "session-1",
		targetHarness: "prime",
		targetId: "prime-1",
		body: "hello",
		projectRoot: "/repo",
		createdAt: "2026-08-23T00:00:00.000Z",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("BridgeStore", () => {
	it("creates the nine durable tables and required indexes", async () => {
		const file = await databasePath();
		const store = BridgeStore.open(file);
		const db = new Database(file, { readonly: true });
		const tables = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as Array<{ name: string }>
		).map(row => row.name);
		const indexes = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
				.all() as Array<{ name: string }>
		).map(row => row.name);
		db.close();
		expect(tables).toEqual([
			"audit",
			"idempotency_tombstones",
			"inbox",
			"metadata",
			"omp_peers",
			"outbox",
			"prime_commands",
			"prime_cursors",
			"receipts",
		]);
		expect(indexes).toEqual(["idempotency_tombstones_expiry", "inbox_claims", "outbox_claims"]);
		store.close();
	});

	it("reopens with the client id, independent cursors, queues, and unknown fields intact", async () => {
		const file = await databasePath();
		const cursor: PrimeDaemonCursor = { generation: "g-1", sequence: 4, futureCursorField: { retained: true } };
		const queued = { ...message(), futureMessageField: ["retained"] } as BridgeMessage & {
			futureMessageField: string[];
		};
		const receipt = {
			meshMessageId: queued.meshMessageId,
			status: "delivered",
			futureReceiptField: { retained: true },
		} as BridgeReceipt & { futureReceiptField: { retained: boolean } };
		const first = BridgeStore.open(file);
		const clientId = first.getOrCreateClientId();
		first.setCursor("session-1", cursor);
		expect(first.enqueueMessage(queued)).toBe(true);
		const claim = first.claimPendingMessages({ now: 1_000, leaseMs: 5_000 })[0];
		expect(claim?.message).toEqual(queued);
		expect(first.recordReceipt(receipt, claim?.claimToken)).toBe(true);
		first.close();

		const reopened = BridgeStore.open(file);
		expect(reopened.getOrCreateClientId()).toBe(clientId);
		expect(reopened.getCursor("session-1")).toEqual(cursor);
		expect(reopened.getLatestReceipt(queued.meshMessageId)).toEqual(receipt);
		expect(reopened.dedupe(queued.idempotencyKey)).toBe(true);
		reopened.close();
	});

	it("reopens inbox and command records before explicit acknowledgement or completion", async () => {
		const file = await databasePath();
		const incoming = {
			...message({ targetHarness: "omp", targetId: "session-2" }),
			futureInboundField: "retained",
		} as BridgeMessage & { futureInboundField: string };
		const envelope = '{"commandId":"cmd-1","future":true}\n';
		const response = '{"commandId":"cmd-1","ok":true}\n';
		const store = BridgeStore.open(file);
		expect(store.putInbox(incoming)).toBe(true);
		store.persistCommand("cmd-1", envelope, "2026-08-23T00:01:00.000Z");
		store.recordCommandResponse("cmd-1", response);
		store.close();

		const reopened = BridgeStore.open(file);
		expect(reopened.listInbox({ peek: true })).toEqual([incoming]);
		expect(reopened.listPendingCommands()).toEqual([
			{ commandId: "cmd-1", envelopeJson: envelope, responseJson: response, createdAt: "2026-08-23T00:01:00.000Z" },
		]);
		expect(reopened.takeFirstInboxForTarget("session-2")).toEqual(incoming);
		reopened.completeCommand("cmd-1");
		expect(reopened.listPendingCommands()).toEqual([]);
		reopened.close();
	});
});
