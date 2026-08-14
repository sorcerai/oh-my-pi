# Prime ModelSpecV1 Implementation Plan

## Goal

Add a small, versioned model interchange contract that Prime Agent and OMP can convert without sharing runtime model types or exposing credential values.

## Scope

- Define `ModelSpecV1` in `@oh-my-pi/pi-catalog`.
- Convert Prime model configuration to and from `ModelSpecV1`.
- Convert OMP model configuration to and from `ModelSpecV1`.
- Parse and resolve local `authRef` values through `AuthStorage`.
- Preserve unknown non-secret source fields in namespaced extension objects.
- Prove both round trips with focused tests.

Out of scope: typed RLM RPC, comparative fan-out benchmarking, credential migration, provider installation, and changes to request retry or account rotation.

## Contract

```ts
interface ModelSpecV1 {
  readonly version: 1;
  readonly providerId: string;
  readonly modelId: string;
  readonly authRef?: string;
  readonly supportsToolUse?: boolean;
  readonly contextLength?: number | null;
  readonly extensions?: Readonly<{
    prime?: Readonly<Record<string, JsonValue>>;
    omp?: Readonly<Record<string, JsonValue>>;
  }>;
}
```

Rules:

- `providerId` and `modelId` are non-empty strings.
- `supportsToolUse` preserves absence separately from `false`.
- `contextLength` is a positive integer, `null` for explicitly unknown, or absent when the source did not supply it.
- `authRef` is opaque in the interchange package. It never contains a token, API key, command, file path, or header value.
- Prime-only unknown fields live in `extensions.prime`. OMP-only unknown fields live in `extensions.omp`.
- Secret-bearing fields are never copied into extensions.
- Converters fail on malformed inputs. They do not silently substitute provider or model defaults.

Local OMP auth references:

- `provider:<providerId>` uses normal `AuthStorage` provider resolution and preserves rotation and retry behavior.
- `oauth-credential:<providerId>:<positiveCredentialId>` selects one durable OAuth credential row.
- Resolution rejects provider mismatches and missing credentials.
- Resolved bearer values remain local and are never serialized into the model spec or converter diagnostics.

## Tasks

### Task 1: Add the catalog interchange contract

Files:

- Create `packages/catalog/src/model-spec-v1.ts`.
- Modify `packages/catalog/src/index.ts`.
- Create `packages/catalog/test/model-spec-v1.test.ts`.

Implement the type, JSON-value type, validation, cloning, and namespaced extension helpers. Reject prototype keys and secret-bearing extension keys. Test valid sparse values, invalid versions and identifiers, context boundaries, JSON-only extensions, prototype keys, and secret-field rejection.

### Task 2: Add local auth reference resolution

Files:

- Create `packages/ai/src/auth-ref.ts`.
- Modify `packages/ai/src/index.ts`.
- Create `packages/ai/test/auth-ref.test.ts`.

Implement `parseLocalAuthRef` and `resolveLocalAuthRef`. Reuse `AuthStorage.getApiKey` for provider references and `getOAuthAccessByCredentialId` for exact OAuth references. Require the expected provider at parse time. Fail closed on malformed references, provider mismatch, missing rows, non-OAuth rows, and missing access tokens. Tests must use an in-memory credential store and must never print resolved credentials.

### Task 3: Add Prime and OMP converters

Files:

- Create `packages/coding-agent/src/config/model-spec-v1.ts`.
- Create `packages/coding-agent/test/model-spec-v1.test.ts`.
- Modify package exports only if an existing public config export surface requires it.

Implement four pure conversions:

- Prime config record -> `ModelSpecV1`.
- `ModelSpecV1` -> Prime config record.
- OMP config record -> `ModelSpecV1`.
- `ModelSpecV1` -> OMP runnable model config record.

Map Prime `provider`/`id`, `supportsTools`, and `contextWindow`; map OMP equivalents with the existing false-only `supportsTools` semantics. Carry `authRef` only as a reference. Preserve unknown JSON fields under their source namespace. Never preserve `apiKey`, `headers`, OAuth/token fields, `!cmd` values, or path-bearing credential fields. Do not infer cost, thinking, API, base URL, output limits, or catalog metadata.

The OMP runnable output may contain model identity, explicit capability/limit values, and `authRef`. Runtime code must resolve the actual model through `ModelRegistry.find(providerId, modelId)` and credentials through the local resolver. The converter itself must not resolve credentials.

### Task 4: Prove round trips

From each package root, run only the focused tests created above:

```bash
bun test test/model-spec-v1.test.ts
bun test test/auth-ref.test.ts
bun test test/model-spec-v1.test.ts
```

Acceptance cases:

1. Prime config -> `ModelSpecV1` -> OMP config -> `ModelSpecV1` -> Prime config preserves provider ID, model ID, `authRef`, explicit tool support, explicit context length, and Prime/OMP extension data.
2. Unknown fields remain namespaced and JSON-equivalent.
3. Secret values and local paths never enter `ModelSpecV1`, extension objects, thrown messages, or serialized test snapshots.
4. Malformed or mismatched `authRef` values fail before credential access.
5. Missing credentials fail clearly without exposing secret material.

### Task 5: Repository verification and review

Run `npm run check` from the repository root. Fix every error, warning, and info. Then run a correctness/security review focused on secret leakage, unknown-field preservation, prototype pollution, nullable context semantics, and absent-versus-false tool support.

## Clean cutover constraints

- Do not rename or repurpose the existing catalog `ModelSpec` runtime input type.
- Do not add inline secret compatibility shims.
- Do not wire credential migration into this slice.
- Do not modify the preserved `sorcerai/mod-a` worktree.
