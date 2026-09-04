# Requirements Writing Guidance

## Atomic requirement test

One requirement should answer:

1. **Actor:** who or what initiates?
2. **Condition:** under what state/input/permission?
3. **Behavior:** what must the product do?
4. **Observable result:** what can a test or reviewer see?
5. **Acceptance evidence:** how is pass/fail established?
6. **Source:** which bet, context claim, policy, or decision requires it?

Split a requirement when independent parts can pass, fail, ship, or roll back separately.

## Normative language

- `MUST` — required for acceptance.
- `SHOULD` — strong preference with documented exception.
- `MAY` — optional capability.
- `NEVER` — prohibited behavior.

Use normative terms only for actual obligations, not background facts.

## Common state checklist

Consider only states that change the contract:

- first use / returning use;
- empty / loading / partial;
- invalid input / dependency failure / timeout;
- permission denied / role change;
- quota / rate / size limit;
- concurrent edit / stale version / conflict;
- migration / backward compatibility;
- cancellation / retry / recovery;
- abuse / fraud / unsafe content;
- offline / degraded mode;
- deletion / export / retention.

## Traceability

Requirements link upstream to evidence/decisions and downstream to work items/tests. Do not use prose similarity as traceability when stable IDs are available.
