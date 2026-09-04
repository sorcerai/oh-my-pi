# Risk-First Vertical Slicing

## Slice test

A valid slice:

- changes one observable user/system outcome;
- proves or retires a named risk;
- maps to requirement IDs;
- has bounded acceptance evidence;
- can be reviewed without waiting for the entire program;
- is reversible or has explicit recovery;
- does not require a second team to guess hidden behavior.

## Risk classes

| Risk | Early proof pattern |
|---|---|
| Data availability/quality | source sample + contract + failure state |
| External integration | sandbox walking skeleton + auth/retry/revoke |
| Model quality | held-out set + failure taxonomy + fallback |
| Performance/cost | representative load/cost probe with threshold |
| Migration | dual-read/write or reversible sample migration |
| Permission/security | role matrix + denied-path tests + audit trail |
| Policy/compliance | scoped decision + prohibited paths + review receipt |
| Unit economics | measured funnel or cost envelope before scale |
| Operational load | manual pilot with time/error capture |

## Dependency types

- `hard`: cannot begin or pass without it;
- `preferred`: improves sequencing but can be parallelized;
- `external`: controlled outside the work owner;
- `decision`: requires product/authority resolution, not engineering labor.

Decision dependencies route upstream. Do not disguise them as “investigation” tickets forever.
