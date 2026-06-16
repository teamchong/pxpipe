# pxpipe side-by-side demo

A self-contained data-retrieval task for the two-column demo (plain Claude Code
vs Claude Code through pxpipe). Requires **Fable 5** — pxpipe only compresses
`claude-fable-5`, so both columns must run Fable, and there is nothing to show
while Fable is offline.

## Files

- `data/*.json` — a small "exported database" (products, customers, orders
  split by year). **Compact JSON on purpose** so reads image cleanly; each file
  fits in one `Read` page.
- `RETURNS_POLICY.md` — revenue rules the task must apply (makes naive shortcuts wrong).
- `EXPECTED.md` — the deterministic ground-truth answer.
- `generate.mjs` — regenerates the data (`node demo/generate.mjs`).

## The prompt (identical in both columns)

> Read all the JSON files in `data/` and `RETURNS_POLICY.md`. Using only those
> files (don't write or run code), which product generated the most net revenue
> in 2025? Apply `RETURNS_POLICY.md` exactly. Give the SKU, product name,
> approximate net revenue, and the single customer who spent the most on that
> product.

Expected: **SKU-0008 "Titanium Node"** (see `EXPECTED.md`). Both columns should
get the same answer; the right column should use far less context (`/context`).

## Running it (when Fable is back) — 2 columns

Start the proxy once in the background (it's a service, not a column):

```bash
npx pxpipe-proxy >/tmp/pxpipe.log 2>&1 &           # 127.0.0.1:47821
```

Then the two side-by-side Claude windows, both in this dir:

```bash
cd /Users/steven_chong/Downloads/repos/pixelpipe/demo

# LEFT column — plain
claude                                             # then: /model claude-fable-5

# RIGHT column — through pxpipe
ANTHROPIC_BASE_URL=http://localhost:47821 claude   # then: /model claude-fable-5
```

In both: paste the prompt, let it finish, then run `/context` and compare.
Same answer (SKU-0008), far less context on the right. Dashboard with the
per-request token delta: <http://127.0.0.1:47821/>.
