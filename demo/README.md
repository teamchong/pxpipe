# pxpipe smart-zone demo

**Shows that pxpipe keeps Claude *sharp* at large context.** Same task, two
columns: the plain column drowns in a huge context and gets the answer wrong
(the "dumb zone"); the pxpipe column images the bulk, keeps a small active
context, and answers correctly.

Both columns must be **Fable 5** (pxpipe only compresses `claude-fable-5`).

---

## 1. Generate the context (prints the prompt + expected answer)
```bash
node demo/generate.mjs
```

## 2. Start the proxy (background, once)
```bash
npx pxpipe-proxy >/tmp/pxpipe.log 2>&1 &        # 127.0.0.1:47821
```

## 3. LEFT column — plain Claude (no proxy)
```bash
cd /Users/steven_chong/Downloads/repos/pixelpipe/demo
claude
```
then: `/model claude-fable-5`

## 4. RIGHT column — through pxpipe
```bash
cd /Users/steven_chong/Downloads/repos/pixelpipe/demo
ANTHROPIC_BASE_URL=http://localhost:47821 claude      # or: pp
```
then: `/model claude-fable-5`

## 5. Paste the prompt (from step 1's output) in BOTH columns
It tells each to read every file in `context/` and answer the ZX-9 question with
only the integer.

## 6. The payoff
- **RIGHT (pxpipe)** → answers the correct integer (it kept the needle readable
  and the active context small).
- **LEFT (plain)** → at a large enough context, gets it **wrong** — drowned in
  the filler. That gap *is* the demo.
- Also run **`/context`** in each: the right column is a fraction of the left.

> If the LEFT column still answers correctly, the context isn't big enough to
> push Fable into the dumb zone — raise `SIZE` in `generate.mjs`, regenerate, and
> retry until plain Claude breaks. (If it never breaks, the win is the `/context`
> reduction itself — report that honestly.)
