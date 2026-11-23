# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/seventhflooroffice-beep/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/seventhflooroffice-beep/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it ranks protocols which record no token yet by an
implied token value derived only from the sealed snapshot, and shows how to
farm each one. An entry for the make.fun bounty "Build the best token launch
radar" (token-radar-01).

## What it does

`main.ts` reads the snapshot at `/input/snapshot.json` (DefiLlama protocol
data, frozen as of 2026-11-14: 758 protocols) and writes:

- `board.json` — the ranked board: every pre-token protocol in the snapshot
  (342 rows), each with an implied value and a five-step farm plan.
- `data.js` — the same board, plus the model's constants and a separate
  comparison list of tokens that already trade, for the dashboard.
- `dashboard/` and `screenshots/` — the static dashboard, copied from this
  repository.
- `dossier.json` — the summary the bounty judge reads, built with
  `buildDossier` from `vendor/makefun-board.ts`.

## The value model

Implied value is computed from the snapshot's own figures, never from a
hardcoded list of names:

```
implied = TVL x category multiple x growth x age x chains x structure
```

- **Category multiple** — for each category, the median market-cap / TVL
  ratio of that category's already-tokenized protocols in the same snapshot.
  Categories with few tokenized peers are shrunk toward the global median;
  a category with none uses the global median.
- **Growth** — the protocol's 7-day TVL change, clamped to a stated range.
- **Age** — days between the day DefiLlama began tracking the protocol and
  the snapshot date: the longer it has run with no token, the more weight.
- **Chains** — a small bonus for multi-chain breadth.
- **Structure** — protocols that are wrapped, staked or bridged products of
  an asset that already trades, and exchange products, are flagged and
  discounted (x0.25): their value would accrue mostly to the existing asset
  or platform, not to a new standalone token. The dashboard badges them and
  can hide them.

Protocols whose token already trades are never ranked; the dashboard shows
the largest of them in a separate comparison section.

Each farm plan gives concrete steps with a cost and a time for every step,
parameterized by the protocol's category, primary chain and TVL tier.

## The dashboard

A static page with no network access: a sortable, filterable board
(search, category, chain, TVL range, watchlist-only, hide flagged
products), a detail view per protocol showing the model's arithmetic step
by step, its farm plan and its category's tokenized comparables, and a
panel stating the model and its limits. An implied value is this entry's
own estimate of what a token would be worth if the protocol's record
stayed as it is — not a prediction that a token will be issued.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only, nothing to install. The program is
deterministic: two runs on the same snapshot write the same bytes.

## Layout

- `main.ts` — entry point: read snapshot, build board, write outputs.
- `lib/model.ts` — the value model, the farm-plan playbooks, validation.
- `dashboard/` — `index.html`, `app.css`, `app.js` (renders `data.js`).
- `screenshots/` — the board, a detail view, and a filtered view.
- `vendor/makefun-board.ts` — the make.fun dossier library (vendored).

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
