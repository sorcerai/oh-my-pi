#!/usr/bin/env python3
"""Focused framing and stream-session regressions for the Swift worker."""
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import time
import unittest
import wave


ROOT = Path(__file__).resolve().parent
BIN = ROOT / ".build/arm64-apple-macosx/release/stt-nemotron"
MAX_AUDIO_BYTES = 4 * 1024 * 1024


def frame(message, payload=b""):
    header = json.dumps(message, separators=(",", ":")).encode()
    return struct.pack("<I", len(header)) + header + payload


def write_all(proc, data, deadline):
    view = memoryview(data)
    fd = proc.stdin.fileno()
    while view:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out writing to stt-nemotron")
        _, writable, _ = select.select([], [fd], [], remaining)
        if not writable:
            raise TimeoutError("timed out writing to stt-nemotron")
        try:
            written = os.write(fd, view)
        except BlockingIOError:
            continue
        except BrokenPipeError as exc:
            raise RuntimeError("stt-nemotron exited while receiving input") from exc
        if written == 0:
            raise RuntimeError("stt-nemotron accepted no input")
        view = view[written:]


def terminate_and_wait(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def close_process_streams(proc):
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream is not None and not stream.closed:
            stream.close()


class NativeProtocolRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BIN.is_file():
            raise unittest.SkipTest(f"worker binary missing: {BIN}")

    def assert_worker_exits(self, data, message):
        proc = subprocess.Popen([str(BIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        os.set_blocking(proc.stdin.fileno(), False)
        deadline = time.monotonic() + 3
        try:
            write_all(proc, data, deadline)
            try:
                proc.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self.fail(message)
        finally:
            terminate_and_wait(proc)
            close_process_streams(proc)

    def test_invalid_header_json_is_fatal(self):
        self.assert_worker_exits(
            struct.pack("<I", 3) + b"not",
            "invalid JSON must stop the worker",
        )

    def test_oversized_audio_frame_is_fatal_before_payload_read(self):
        self.assert_worker_exits(
            frame({"type": "stream_audio", "id": "oversized", "byteCount": MAX_AUDIO_BYTES + 4}),
            "oversized audio must stop before allocation/read",
        )

    def test_stalled_reader_write_times_out(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        os.set_blocking(proc.stdin.fileno(), False)
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                write_all(proc, b"x" * MAX_AUDIO_BYTES, started + 0.2)
            self.assertLess(time.monotonic() - started, 1.0)
        finally:
            terminate_and_wait(proc)
            close_process_streams(proc)

    def test_stale_cancel_does_not_reset_active_session(self):
        wav_path = Path("/tmp/omp-stt-test.wav")
        if not wav_path.is_file():
            raise unittest.SkipTest(f"Hello fixture missing: {wav_path}")
        with wave.open(str(wav_path), "rb") as wav:
            pcm = wav.readframes(wav.getnframes())
        samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
        first_samples = samples[:16000]
        first_chunk = struct.pack(f"<{len(first_samples)}f", *(s / 32768.0 for s in first_samples))

        proc = subprocess.Popen([str(BIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        os.set_blocking(proc.stdin.fileno(), False)
        os.set_blocking(proc.stdout.fileno(), False)
        deadline = time.monotonic() + 120
        try:
            write_all(proc, frame({"type": "stream_start", "id": "s1", "language": "en"}), deadline)
            write_all(
                proc,
                frame({"type": "stream_audio", "id": "s1", "byteCount": len(first_chunk)}, first_chunk),
                deadline,
            )
            write_all(proc, frame({"type": "stream_cancel", "id": "stale"}), deadline)
            write_all(proc, frame({"type": "stream_stop", "id": "s1"}), deadline)
            done = None
            pending = b""
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                ready, _, _ = select.select([proc.stdout.fileno()], [], [], min(remaining, 1.0))
                if not ready:
                    continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    if not raw.strip():
                        continue
                    message = json.loads(raw)
                    if message.get("type") == "stream_done":
                        done = message.get("text")
                        break
                if done is not None:
                    break
            self.assertIsInstance(done, str)
            self.assertTrue(done.strip(), f"stale cancel reset active stream: {done!r}")
        finally:
            terminate_and_wait(proc)
            close_process_streams(proc)


if __name__ == "__main__":
    unittest.main()
