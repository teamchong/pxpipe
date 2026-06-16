# Expected answer (ground truth)

Computed deterministically by `generate.mjs`. Both demo columns should land here.

## Answer
| field | value |
|---|---|
| SKU | `SKU-0008` |
| product name | Titanium Node |
| net revenue (2025, recognized) | ~$71,520 |
| top customer | Nora Moreau (`CUST-020`) |
| that customer's spend on it | ~$4,320 |

Margin over the #2 product: **$61,583.99** — a wide,
unambiguous gap, so the *ranking* survives a stray glyph misread even if a
dollar total is off by a little. Grade on the identity (SKU/name/customer),
treat the dollar figure as approximate.

## Why it can't be shortcut
- **Year filter:** orders span 2024–2026; only 2025 counts (note the file names).
- **Status filter:** only `fulfilled`+`delivered` count — a model that assumes
  "fulfilled only" gets a different number, proving it read RETURNS_POLICY.md.
- **Three-way join:** revenue from the order files, name from products.json,
  top-customer name from customers.json.

## File sizes (each well under Read's ~25k-token page cap)
| file | chars | ~tokens |
|---|---:|---:|
| products.json | 5,282 | 2,765 |
| customers.json | 8,035 | 4,207 |
| orders-2024.json | 21,980 | 11,508 |
| orders-2025-h1.json | 32,230 | 16,874 |
| orders-2025-h2.json | 32,250 | 16,885 |
| orders-2026.json | 20,967 | 10,977 |

Real per-request savings on this content: run `node demo/preflight.mjs`.
Your historical real savings: run `node demo/analyze-events.mjs`.
