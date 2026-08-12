# Prime bridge

`@oh-my-pi/prime-bridge` is a local, authenticated control mesh between OMP and a Prime Agent daemon. It keeps bridge messages and Prime event cursors in SQLite so a bridge restart does not resend completed messages or lose event position.

## Setup

Install the OMP workspace and make the bridge binary available:

```sh
bun install
```

The bridge listens on `127.0.0.1` only. The default state directory is `~/.omp/agent/prime-bridge`.

| Path | Purpose |
| --- | --- |
| `~/.omp/agent/prime-bridge/bridge.sqlite` | Durable outbox, inbox, receipts, audit rows, command journal, and Prime cursors |
| `~/.omp/agent/prime-bridge/token` | Bridge bearer token. The bridge creates this file with mode `0600`. |
| `~/.prime/agent/omp-bridge.json` | Prime pointer containing only the bridge URL and token-file path. The bridge creates it with mode `0600`. |

Use a different state directory when you need an isolated bridge:

```sh
omp-prime-bridge \
  --state-dir "$HOME/.omp/agent/prime-bridge" \
  --port 8787 \
  --token-file "$HOME/.omp/agent/prime-bridge/token" \
  --prime-config-file "$HOME/.prime/agent/omp-bridge.json"
```

The CLI supports `--state-dir`, `--port`, `--token-file`, and `--prime-config-file`. It prints the listening URL after startup. The bridge always binds to loopback. The default CLI port is `0`, which lets the operating system select a free port.

## Enable OMP

Set the bridge settings in the active OMP global configuration:

```sh
omp config set primeBridge.enabled true
omp config set primeBridge.url http://127.0.0.1:8787
omp config set primeBridge.tokenPath "$HOME/.omp/agent/prime-bridge/token"
```

The settings are:

| Setting | Default | Meaning |
| --- | --- | --- |
| `primeBridge.enabled` | `false` | Allows OMP to create the external Prime peer provider. |
| `primeBridge.url` | unset | The loopback bridge URL. Auto-start requires a URL with a fixed port. |
| `primeBridge.tokenPath` | unset | The file that contains the bridge bearer token. |
| `primeBridge.autoStart` | `false` | Asks the OMP launch broker to ensure the detached bridge is running. |

Start the bridge yourself, or enable broker start:

```sh
omp config set primeBridge.autoStart true
```

`autoStart` uses the machine-global launch broker. It starts the `omp-prime-bridge` application with the configured port and token path. It does not start a bridge with an operating-system service manager.

`hub list` shows Prime sessions with `prime://` addresses. Use the exact listed address with `hub send` or `hub wait`; reserved addresses never route to local peers.

## Token and trust

The bridge creates the token on first start and reads it for each authenticated request. OMP sends it as `Authorization: Bearer <token>`. Do not copy the token into the Prime pointer file or into logs.

The bridge accepts `/health` without authentication. Every `/v1/*` route requires the bearer token. The bridge rejects a non-empty `Origin` unless the origin is explicitly allowlisted by server configuration. The public server options have no default allowed origins.

## Recovery

The SQLite database is the recovery record. Keep `bridge.sqlite` and the token file together. To recover after a clean or unclean bridge stop, start the bridge with the same state directory and token path.

Completed OMP-to-Prime sends retain their receipt. A repeated request with the same idempotency key returns the stored receipt and does not send another Prime command. The Prime command journal retries the exact stored mutation envelope. It does not create a new command ID when the result is uncertain.

Prime event cursors store a generation and sequence for each active session. When the Prime daemon supports `event_sequence`, the bridge sends the stored cursor during the next attach. A changed generation starts a new cursor stream.

## Supervision limits

The OMP launch broker starts one machine-global bridge named `prime-bridge` with `detached: true`, `persist: true`, and `restart: "always"`. The detached bridge can survive an OMP or broker exit.

`restart: "always"` only works while the launch broker has its lifecycle record. If the bridge crashes while the broker is down, OMP does not promise an immediate restart. The bridge starts again when the broker recovers and OMP calls the ensure path. Use an external supervisor when you need restart guarantees during broker downtime.

The bridge is not an OMP session. OMP external Prime peers stay outside `AgentRegistry`, and the bridge cannot access live OMP tools. A disconnected OMP session can therefore make a target unavailable without damaging Prime or OMP session state.


## Session resume proof and limits

Session resume supports the public Prime v3 JSONL reader/projector and OMP
session-v3 reader/projector APIs. The deterministic offline proof covers the
fixture revisions `prime-v3.jsonl` and `omp-v3.jsonl`, including every branch
tip, role ordering, tool-call/result ID and name continuity, exact historical
CAS bytes, and projection loss parity. Each fixture completes an A-to-B-to-A
projection through both native formats.

OMP continuation opens the imported file with `SessionManager.open()`,
navigates a tool-bearing native branch, and sends a follow-up through the
public OpenAI-compatible adapter. True resume means destination-native open
and navigation, followed by a real follow-up prompt whose complete provider
request is locally schema-validated. Historical tool calls and results must
remain paired. The proof uses a loopback-only faux OpenAI-compatible server
and never needs a provider key or a paid request.

Prime-native continuation is optional in the default package test because the
bridge workspace does not bundle a Prime executable. Without
`PRIME_AGENT_BIN`, Bun skips only the native Prime RPC case.

Run the explicit required native gate with an installed Prime Agent binary:

```sh
PRIME_AGENT_BIN=/path/to/prime-agent bun run test:session-resume:native
```

The required gate fails before the integration test if `PRIME_AGENT_BIN` is
absent. With the binary, it exercises `switch_session`, a follow-up RPC prompt,
and the complete tool-bearing loopback provider request after a
Prime-to-OMP-to-Prime projection.

The remaining default cases still prove destination JSONL projection, trusted
bridge metadata, CAS read-back, exhaustive branch validation, OMP-native
continuation, and both A-to-B-to-A paths. An upstream `pi` binary is not a
substitute for the Prime Agent fork.

### Inspect and convert sessions

The bridge CLI detects the source format by running both strict native readers:

```sh
omp-prime-bridge session inspect /path/to/session.jsonl
omp-prime-bridge session inspect /path/to/session.jsonl --json
omp-prime-bridge session convert /path/to/session.jsonl --to omp
omp-prime-bridge session convert /path/to/session.jsonl --to prime --output /safe/new-directory
```

Conversion is create-only and refuses an existing output path. It stages the
native session and CAS data before one atomic rename. Use
`--loss-policy reject` to fail before publication when the canonical reader or
destination projector records any loss. Use `--activate` to preserve and select
the source active leaf in destination-native metadata. Without `--activate`,
the complete branch tree is retained but the destination uses its native
default leaf selection. Neither mode changes a live harness process.

Import is create-only. Keep the source session and its CAS/state directory as
the backup before importing. The bridge writes destination files below the
configured Prime home or OMP session directory and never overwrites an
existing destination. Unsupported roles, unavailable provider payloads, and
unrepresentable metadata stay in the loss ledger. They are not silently
reconstructed.

The public OMP tree importer generates its own 256-byte title slot. It cannot
reproduce the exact source title-slot bytes. The OMP projector records this as
an `entry_metadata_unrepresentable` loss with source type `title`.

Provider and model continuity is limited to the destination adapter. A
historical provider/model identity is metadata unless the destination has a
compatible configured model. Provider-native opaque payloads are replayed only
when retained in CAS and accepted by the destination adapter. The proof uses
OpenAI Chat Completions wire history and does not prove provider-side cache,
server-side conversation, credential, or model-account continuity.