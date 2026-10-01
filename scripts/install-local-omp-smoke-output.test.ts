import { describe, expect, test } from "bun:test";
import { outputCarriesMarker } from "./install-local-omp-smoke-output";

const marker = "OMP_LOCAL_INSTALL_FLASH_WORKER_OK";

describe("local installer nested result", () => {
	test("accepts a completed worker marker serialized as a JSON string", () => {
		expect(outputCarriesMarker(JSON.stringify(marker), undefined, marker)).toBe(true);
	});

	test("rejects a JSON object wrapper or an unrelated string", () => {
		expect(outputCarriesMarker(JSON.stringify({ data: marker }), undefined, marker)).toBe(false);
		expect(outputCarriesMarker(JSON.stringify("WRONG_MARKER"), undefined, marker)).toBe(false);
	});

	test("retains raw result and validated structured result contracts", () => {
		expect(outputCarriesMarker(marker, undefined, marker)).toBe(true);
		expect(outputCarriesMarker("untrusted presentation", { status: "valid", data: marker }, marker)).toBe(true);
		expect(outputCarriesMarker(JSON.stringify(marker), { status: "invalid", data: marker }, marker)).toBe(false);
	});
});
