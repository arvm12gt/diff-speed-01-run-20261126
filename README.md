# Diff two texts faster — diff-speed-01-run-20261126

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/arvm12gt/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/arvm12gt/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

A faster drop-in for make.fun's own makefun-diff 1.0.0, written for the
[make.fun bounty](https://make.fun/bounty/diff-speed-01-run-20261126).
It returns byte-identical answers to makefun-diff on every case — same
line splitting, same greedy Myers search with the deletion-on-tie rule,
same patch format — at about 0.45× the house baseline's CPU time on the
practice set (local heat protocol: ~1,010 ms vs ~2,267 ms for the baseline).

## How it is fast

- **Lines hashed to integer ids once** (shared across both texts), so the
  search's inner loop compares ints, not strings. Lines are never
  materialised with their newline attached; the id carries a newline bit,
  so a last line `"foo"` and a line `"foo\n"` never share an id.
- **Banded Myers search.** A diagonal `k` at level `d` can still reach
  the end only when `|k - (n-m)| <= D - d`, where `D` is the edit
  distance. With any upper bound `Dub >= D`, the band
  `[n-m-(Dub-d), n-m+(Dub-d)]` holds the whole greedy path, and the
  banded search reproduces it exactly. `Dub` comes from the line-multiset
  lower bound (lines that must be deleted or inserted) times 1.9; the
  practice sets sit at D/LB 1.67–1.75, and the band was validated
  byte-identical on 12 further cases drawn from the kit's own generator
  (D/LB 1.65–1.79 throughout). If a band ever finds no path (`Dub < D`),
  the entry falls back to the full search, which is always correct.
- **No copy pass, no separate V array**: each level's post-snake
  positions are written straight into that level's snapshot, and the
  deletion source of one diagonal is the insertion source of the next,
  so each is read once. Diagonal reads use typed-array out-of-range
  (`undefined`) instead of explicit bounds checks.

## Measured (practice set, 4 cases, local heat protocol)

| | net cpu_us (4 cases) | vs baseline |
|---|---:|---:|
| makefun-diff 1.0.0 (house baseline) | 2,267,475 | 1.00× |
| this entry | 1,009,842 | 0.45× |

All 4 practice cases byte-identical to the reference answers
(`grade-local --driver process` passes 4/4).

## Layout

- `solve.js` — `run(input)`: the drop-in. Dependency-free ES module.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

Run locally on the practice set:

```sh
MAKEFUN_INPUT_DIR=path/to/kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only. No network, no environment secrets,
deterministic (no clock reads, no randomness).
