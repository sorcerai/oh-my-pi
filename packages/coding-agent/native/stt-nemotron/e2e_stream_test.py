#!/usr/bin/env python3
"""E2E: WAV (16k mono s16) -> stream_start/audio/stop -> stt-nemotron binary."""
import array
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import time
import wave


ROOT = Path(__file__).resolve().parent
BIN = ROOT / ".build/arm64-apple-macosx/release/stt-nemotron"
WAV = Path("/tmp/omp-stt-test.wav")
DEADLINE_SECONDS = 120


def frame(msg, payload=b""):
    hdr = json.dumps(msg, separators=(",", ":")).encode()
    return struct.pack("<I", len(hdr)) + hdr + payload


def write_frame(proc, data, deadline):
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


def read_available(proc, pending, timeout, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("timed out waiting for stt-nemotron")
    fd = proc.stdout.fileno()
    ready, _, _ = select.select([fd], [], [], min(timeout, remaining))
    if not ready:
        return pending, [], False
    chunk = os.read(fd, 65536)
    if not chunk:
        return pending, [], True
    pending += chunk
    messages = []
    while b"\n" in pending:
        raw, pending = pending.split(b"\n", 1)
        if raw.strip():
            messages.append(json.loads(raw))
    return pending, messages, False


def terminate_and_wait(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def main():
    with wave.open(str(WAV), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, w.getparams()
        pcm = w.readframes(w.getnframes())

    s16 = array.array("h")
    s16.frombytes(pcm)
    f32 = [s / 32768.0 for s in s16]
    chunk_samples = 4000  # 250 ms per stream_audio frame

    proc = subprocess.Popen([str(BIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    os.set_blocking(proc.stdin.fileno(), False)
    os.set_blocking(proc.stdout.fileno(), False)
    deadline = time.monotonic() + DEADLINE_SECONDS
    pending = b""
    partials = 0
    has_nonempty_partial = False
    done = None

    def consume(messages):
        nonlocal partials, has_nonempty_partial, done
        for message in messages:
            message_type = message.get("type")
            if message_type == "partial":
                partials += 1
                if isinstance(message.get("text"), str) and message["text"].strip():
                    has_nonempty_partial = True
                if partials <= 3 or partials % 10 == 0:
                    print(f"partial[{partials}]: {message.get('text')!r}")
            elif message_type == "segment":
                print(f"segment[{message.get('index')}]: {message.get('text')!r}")
            elif message_type == "stream_done":
                done = message.get("text")
            elif message_type == "error":
                raise RuntimeError(f"stt-nemotron: {message.get('error')}")
            else:
                print(f"{message_type}: {json.dumps(message)[:200]}")

    try:
        write_frame(proc, frame({"type": "stream_start", "id": "s1", "language": "en"}), deadline)

        for i in range(0, len(f32), chunk_samples):
            samples = f32[i : i + chunk_samples]
            payload = struct.pack(f"<{len(samples)}f", *samples)
            write_frame(
                proc,
                frame({"type": "stream_audio", "id": "s1", "byteCount": len(payload)}, payload),
                deadline,
            )
            pending, messages, closed = read_available(proc, pending, 0, deadline)
            consume(messages)
            if closed:
                raise RuntimeError("stt-nemotron exited before stream_stop")

        write_frame(proc, frame({"type": "stream_stop", "id": "s1"}), deadline)
        while done is None:
            pending, messages, closed = read_available(proc, pending, 1, deadline)
            consume(messages)
            if closed:
                raise RuntimeError("stt-nemotron exited before stream_done")

        if not has_nonempty_partial or not isinstance(done, str) or not done.strip():
            raise RuntimeError(f"expected nonempty partial and stream_done, got {done!r}")
        print("---")
        print(f"partials: {partials}")
        print(f"stream_done: {done!r}")
    finally:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        terminate_and_wait(proc)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, RuntimeError, TimeoutError, ValueError, wave.Error) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
