# Adding a dashboard language

The live dashboard (`src/dashboard/fragments.ts`) is server-rendered — no
client bundle, no external i18n library. Every user-visible string lives in
one typed dictionary per language under `src/dashboard/locales/`, and the
dashboard negotiates a language per request (an explicit `pp-lang` cookie set
by the language selector beats the browser's `Accept-Language` header, which
beats the English default).

## Add a new language in three steps

1. **Copy the reference locale.**

   ```bash
   cp src/dashboard/locales/en.ts src/dashboard/locales/<code>.ts
   ```

   Use a two-letter code matching the language subtag you want to match
   against `Accept-Language` (e.g. `fr`, `de`, `es`, `pt`, `ja`).

2. **Translate every value**, keeping the keys untouched. Open the new file
   and replace each string. The file exports a `const <code>: Messages`
   (rename `en` to your code) — leave the `Messages` type import/re-export
   alone; only `en.ts` defines the type.

   ```ts
   import type { Messages } from './en.js';

   export const fr: Messages = {
     tagline: '...',
     // ...
   };
   ```

   TypeScript enforces completeness: if you forget a key, or add one that
   doesn't exist, `pnpm run build` (or `pnpm test`) fails to compile with the
   exact key name. There's no way to ship a half-translated locale silently.

   A few entries are **functions**, not plain strings — they build a
   sentence around a number, so plurals/agreement can differ by language
   (e.g. `heroSinceStart: (requests, formatted) => ...`, where `requests` is
   the raw count for pluralization and `formatted` is the already
   locale-formatted number to display). Keep the same parameters and return
   a string; you have full freedom over word order and pluralization rules
   inside.

   **Don't translate:** model IDs/labels (`Fable 5`, `claude-fable-5`, …),
   environment variable names (`PXPIPE_MODELS`, `OPENAI_UPSTREAM`, …), code
   samples, or the math-drawer formulas (`saved = baseline − actual`, etc.) —
   those are technical identifiers and formulas, not prose, and stay
   identical across every locale for scannability.

3. **Register it** in `src/dashboard/i18n.ts`:

   ```ts
   import { fr } from './locales/fr.js';

   export const LOCALES = {
     en: { label: 'English', messages: en },
     it: { label: 'Italiano', messages: it },
     fr: { label: 'Français', messages: fr },
   } as const satisfies Record<string, { label: string; messages: Messages }>;
   ```

That's it. The language `<select>` in the topbar is generated from
`LOCALES`, so your new language appears there automatically, and
`resolveLang()` will match it against `Accept-Language` (e.g. `fr-CA` → `fr`)
with no further wiring.

## Verifying

```bash
pnpm test        # existing dashboard tests assert English strings by default
                  # (the default language when no cookie/header is present)
pnpm run build
```

Then run the dashboard (`pnpm run restart` or `node dist/node.js`) and either:
- set your browser's language preference and reload `/`, or
- open the dashboard and use the language `<select>` in the top-right corner
  — it sets a `pp-lang` cookie and reloads.

## Why a cookie, not just `Accept-Language`?

The dashboard is server-rendered and htmx polls several `/fragments/*`
endpoints every 2–5 seconds. The server needs to know the chosen language on
*every one of those requests*, not just the initial page load — a cookie is
the simplest way to make the browser resend that choice automatically,
without touching every `hx-get` attribute in the page.
