import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shutdownSttClient, sttClient } from "../stt/asr-client";
import { isSttModelCached } from "../stt/downloader";
import {
	createNemotronSttSubprocess,
	createNemotronWorkerHandle,
	encodeNemotronFrame,
	resolveNemotronWorkerPath,
} from "../stt/nemotron-worker-client";

/**
 * Native Nemotron STT worker end-to-end test. Requires the built
 * `stt-nemotron` binary and the FluidAudio latin/1120ms model cache (shared
 * with VoxKey). Skips cleanly on machines without either so the suite stays
 * portable; on a configured machine this proves spawn → framing → stream →
 * stop → transcript through the same SttClient the editor uses.
 */

const binary = resolveNemotronWorkerPath();
const modelReady = binary !== null && (await isSttModelCached("nemotron"));
const wavPath = process.env.OMP_STT_TEST_WAV ?? "/tmp/omp-stt-test.wav";
const wavAvailable = fs.existsSync(wavPath);

/** Decode a 16 kHz mono s16-le WAV into normalized Float32 samples. */
function readTestWav(file: string): Float32Array {
	const data = fs.readFileSync(file);
	const dataOffset = data.indexOf("data") + 8;
	const pcm = new Int16Array(data.buffer, data.byteOffset + dataOffset, (data.length - dataOffset) / 2);
	const samples = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
	return samples;
}

describe("nemotron stt worker", () => {
	test("encodes the Nemotron download variant without an audio payload", () => {
		const frame = encodeNemotronFrame({ type: "download", id: "download-1", modelKey: "nemotron" });
		const headerLength = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
		const headerEnd = 4 + headerLength;
		const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, headerEnd))) as Record<string, unknown>;

		expect(header).toMatchObject({
			type: "download",
			id: "download-1",
			languageCode: "en",
			chunkMs: 1120,
		});
		expect(frame.subarray(headerEnd)).toHaveLength(0);
	});
	test.skipIf(!(binary && modelReady))("binary + model resolve", () => {
		expect(fs.statSync(binary!).isFile()).toBe(true);
		expect(modelReady).toBe(true);
	});

	test("reports an unintentional zero-exit worker", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nemotron-worker-"));
		const script = path.join(dir, "worker");
		try {
			fs.writeFileSync(script, "#!/bin/sh\nsleep 0.05\nexit 0\n");
			fs.chmodSync(script, 0o755);
			const spawned = createNemotronSttSubprocess(script);
			const worker = createNemotronWorkerHandle(spawned);
			const error = new Promise<Error>(resolve => worker.onError(resolve));
			await expect(error).resolves.toMatchObject({
				message: expect.stringContaining("code 0"),
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 5_000);

	test.skipIf(!(binary && modelReady && wavAvailable))(
		"stream: partials then final transcript via sttClient",
		async () => {
			const samples = readTestWav(wavPath);
			const partials: string[] = [];
			const segments: string[] = [];
			const stream = sttClient.startStream("nemotron", {
				language: "en",
				onPartial: text => partials.push(text),
				onSegment: text => segments.push(text),
			});
			try {
				const frameSamples = 4000;
				for (let i = 0; i < samples.length; i += frameSamples) {
					stream.pushAudio(samples.subarray(i, i + frameSamples));
				}
				const text = await stream.stop();
				expect(text.trim().length).toBeGreaterThan(0);
				// The worker streams true partials (no endpointer segmentation).
				expect(partials.length).toBeGreaterThan(0);
				// One final segment, emitted at stop.
				expect(segments.length).toBeLessThanOrEqual(1);
			} finally {
				await shutdownSttClient();
			}
		},
		120_000,
	);
});
