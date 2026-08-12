import { describe, expect, it } from "bun:test";
import { collectCasRefs } from "../src/session/report";
import type { SessionSpecV1 } from "../src/session/spec";

const ref = (digit: string) => ({ hash: digit.repeat(64), byteLength: Number(digit) });

describe("session report CAS references", () => {
	it("collects only declared CAS reference fields", () => {
		const spec: SessionSpecV1 = {
			specVersion: 1,
			header: {
				originHarness: "omp",
				sourceSessionId: "session-1",
				title: "Example",
				cwd: "/repo",
				createdAt: "2026-08-12T00:00:00.000Z",
				sourceSchema: "omp-v3",
				sourceRef: ref("1"),
			},
			nodes: [
				{
					id: "assistant",
					parentId: null,
					role: "assistant",
					content: { hash: "a".repeat(64), byteLength: 10 },
					thinkingRef: ref("2"),
					providerPayloadRef: ref("3"),
					metadata: {
						sourceLineRef: ref("4"),
						sourceMessageRef: ref("5"),
						titleSlotRef: ref("6"),
						thinkingRefs: [ref("7"), ref("8")],
						userContent: { hash: "b".repeat(64), byteLength: 11 },
					},
					toolPairs: [
						{
							toolName: "read",
							callId: "call-1",
							argsSnapshot: { hash: "c".repeat(64), byteLength: 12 },
							originalCallRef: ref("9"),
							synthesizedCallRef: { hash: "d".repeat(64), byteLength: 13 },
							resultRef: { hash: "e".repeat(64), byteLength: 14 },
						},
					],
				},
			],
			activeLeafId: "assistant",
			nativeIdMap: {},
			lossLedger: [],
		};

		expect(collectCasRefs(spec)).toEqual([
			ref("1"),
			ref("2"),
			ref("3"),
			ref("4"),
			ref("5"),
			ref("6"),
			ref("7"),
			ref("8"),
			ref("9"),
			{ hash: "d".repeat(64), byteLength: 13 },
			{ hash: "e".repeat(64), byteLength: 14 },
		]);
	});
});
