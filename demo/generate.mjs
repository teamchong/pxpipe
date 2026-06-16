/**
 * Deterministic demo-data generator for the pxpipe side-by-side demo.
 *
 * Design constraints discovered empirically (see demo/README.md "Why this shape"):
 *   1. COMPACT json (no pretty-print). Pretty-printed JSON is one short field
 *      per line; each line eats a full render row, so pxpipe can only pack
 *      ~2.8k chars/page and TRUNCATES large reads (silent data loss). Compact
 *      arrays reflow into full rows and image with ~0 loss.
 *   2. SPLIT across several files, each comfortably under Claude Code's Read
 *      page cap (~25k tokens). A single giant file/line makes Read paginate
 *      and warn the model not to answer from one page. Several moderate files
 *      = one clean Read each = exactly how real sessions accrue context.
 *   3. The answer is a RANKING with a wide margin (not exact-to-the-cent), so
 *      it survives the occasional glyph misread that pxpipe's lossy tier can
 *      produce. Identity (SKU + name + customer) is the headline; the dollar
 *      figure is supporting.
 *
 * Deterministic (fixed-seed xorshift32, no Math.random/Date) so the committed
 * files and EXPECTED.md always agree. Re-run: node demo/generate.mjs
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
mkdirSync(DATA, { recursive: true });
for (const f of readdirSync(DATA)) if (f.endsWith(".json")) unlinkSync(join(DATA, f));

let _s = 0x9e3779b9 >>> 0;
function rnd() { let s = _s; s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; _s = s; return s / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
function weighted(pairs) { const t = pairs.reduce((x, [, w]) => x + w, 0); let r = rnd() * t; for (const [v, w] of pairs) if ((r -= w) < 0) return v; return pairs[pairs.length - 1][0]; }
const pad = (n, w) => String(n).padStart(w, "0");
const money = (c) => Number((c / 100).toFixed(2));

// --- products ---------------------------------------------------------------
const CATS = ["Widgets", "Gadgets", "Tools", "Accessories", "Bundles"];
const ADJ = ["Titanium", "Quantum", "Eco", "Nimbus", "Apex", "Lumen", "Forge", "Vertex", "Halcyon", "Onyx", "Cobalt", "Solstice", "Maple", "Arctic", "Meridian", "Cinder", "Drift", "Helix", "Ember", "Glacier"];
const NOUN = ["Hub", "Clamp", "Sensor", "Driver", "Mount", "Coupler", "Relay", "Bracket", "Module", "Adapter", "Gauge", "Valve", "Beacon", "Spindle", "Cartridge", "Manifold", "Toolkit", "Cradle", "Latch", "Node"];
const PRODUCTS = [];
for (let i = 1; i <= 50; i++) PRODUCTS.push({ sku: `SKU-${pad(i, 4)}`, name: `${pick(ADJ)} ${pick(NOUN)}`, category: pick(CATS), unit_price: money(ri(500, 25000)), supplier_id: `SUP-${pad(ri(1, 12), 2)}` });
const priceCents = new Map(PRODUCTS.map((p) => [p.sku, Math.round(p.unit_price * 100)]));
// One deliberate bestseller so the answer is an unambiguous ranking (wide
// margin over #2), robust to a stray glyph misread.
const HERO = PRODUCTS[7];

// --- customers --------------------------------------------------------------
const FIRST = ["Ava", "Liam", "Noah", "Mia", "Ethan", "Zoe", "Kai", "Nora", "Leo", "Ivy", "Owen", "Maya", "Finn", "Ruby", "Cole", "Iris", "Jude", "Lena", "Reed", "Tess", "Hugo", "Esme", "Milo", "Wren"];
const LAST = ["Okafor", "Nguyen", "Patel", "Garcia", "Kim", "Rossi", "Haddad", "Silva", "Novak", "Tanaka", "Mendez", "Bauer", "Larsen", "Costa", "Ahmed", "Petrov", "Cohen", "Reyes", "Walsh", "Fischer", "Khan", "Moreau", "Singh"];
const REGIONS = ["NA-East", "NA-West", "EU-Central", "EU-North", "APAC", "LATAM"];
const CUSTOMERS = [];
for (let i = 1; i <= 80; i++) CUSTOMERS.push({ id: `CUST-${pad(i, 3)}`, name: `${pick(FIRST)} ${pick(LAST)}`, region: pick(REGIONS), tier: weighted([["standard", 5], ["silver", 3], ["gold", 2], ["platinum", 1]]), signup_date: `${ri(2021, 2024)}-${pad(ri(1, 12), 2)}-${pad(ri(1, 28), 2)}` });
const custName = new Map(CUSTOMERS.map((c) => [c.id, c.name]));

// --- orders -----------------------------------------------------------------
const STATUS = [["fulfilled", 42], ["delivered", 24], ["returned", 9], ["refunded", 8], ["cancelled", 10], ["pending", 7]];
function makeOrders(n, yearPicker, startId) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const items = [];
    const k = weighted([[1, 5], [2, 4], [3, 2], [4, 1]]);
    for (let j = 0; j < k; j++) { const p = rnd() < 0.16 ? HERO : pick(PRODUCTS); items.push({ sku: p.sku, qty: ri(1, 6), unit_price: p.unit_price }); }
    out.push({ order_id: `ORD-${pad(startId + i, 6)}`, customer_id: `CUST-${pad(ri(1, 80), 3)}`, date: `${yearPicker()}-${pad(ri(1, 12), 2)}-${pad(ri(1, 28), 2)}`, status: weighted(STATUS), items });
  }
  return out;
}
// Files: two out-of-period (2024, 2026) + two in-period halves of 2025. The
// file names encode the year so the "2025 only" filter is unmistakable.
const o2024 = makeOrders(120, () => 2024, 100001);
const h1 = makeOrders(170, () => 2025, 100201).map((o) => ({ ...o, date: `2025-${pad(ri(1, 6), 2)}-${pad(ri(1, 28), 2)}` }));
const h2 = makeOrders(170, () => 2025, 100401).map((o) => ({ ...o, date: `2025-${pad(ri(7, 12), 2)}-${pad(ri(1, 28), 2)}` }));
const o2026 = makeOrders(110, () => 2026, 100601);
const ALL = [...o2024, ...h1, ...h2, ...o2026];

// --- ground truth: net 2025 revenue per product (recognized statuses) -------
const RECOGNIZED = new Set(["fulfilled", "delivered"]);
const rev = new Map(), spend = new Map();
for (const o of ALL) {
  if (!o.date.startsWith("2025-") || !RECOGNIZED.has(o.status)) continue;
  for (const it of o.items) {
    const c = it.qty * (priceCents.get(it.sku) ?? Math.round(it.unit_price * 100));
    rev.set(it.sku, (rev.get(it.sku) ?? 0) + c);
    let m = spend.get(it.sku); if (!m) { m = new Map(); spend.set(it.sku, m); }
    m.set(o.customer_id, (m.get(o.customer_id) ?? 0) + c);
  }
}
const ranked = [...rev.entries()].sort((a, b) => b[1] - a[1]);
const [winSku, winCents] = ranked[0]; const runnerCents = ranked[1][1];
const winP = PRODUCTS.find((p) => p.sku === winSku);
const [topCust, topCents] = [...spend.get(winSku).entries()].sort((a, b) => b[1] - a[1])[0];

// --- write compact files ----------------------------------------------------
const jw = (name, obj) => { const t = JSON.stringify(obj); writeFileSync(join(DATA, name), t + "\n"); return t.length; };
const files = {
  "products.json": jw("products.json", PRODUCTS),
  "customers.json": jw("customers.json", CUSTOMERS),
  "orders-2024.json": jw("orders-2024.json", o2024),
  "orders-2025-h1.json": jw("orders-2025-h1.json", h1),
  "orders-2025-h2.json": jw("orders-2025-h2.json", h2),
  "orders-2026.json": jw("orders-2026.json", o2026),
};

writeFileSync(join(HERE, "RETURNS_POLICY.md"), `# Revenue Recognition Policy

Defines how to compute **net revenue** from the order files. Apply exactly.

## Recognized (counts toward revenue)
An order line counts **only** when the order \`status\` is one of:
- \`fulfilled\`
- \`delivered\`

## Excluded (counts as zero)
- \`returned\`
- \`refunded\`
- \`cancelled\`
- \`pending\`

## Line revenue
\`line_revenue = qty * unit_price\` (unit_price is in dollars). Sum across all
recognized line items per product.

## Reporting period
"2025" = orders whose \`date\` is in calendar year 2025. The \`orders-2024.json\`
and \`orders-2026.json\` files are out of period and excluded regardless of status.
`);

writeFileSync(join(HERE, "EXPECTED.md"), `# Expected answer (ground truth)

Computed deterministically by \`generate.mjs\`. Both demo columns should land here.

## Answer
| field | value |
|---|---|
| SKU | \`${winSku}\` |
| product name | ${winP.name} |
| net revenue (2025, recognized) | ~$${money(winCents).toLocaleString()} |
| top customer | ${custName.get(topCust)} (\`${topCust}\`) |
| that customer's spend on it | ~$${money(topCents).toLocaleString()} |

Margin over the #2 product: **$${money(winCents - runnerCents).toLocaleString()}** — a wide,
unambiguous gap, so the *ranking* survives a stray glyph misread even if a
dollar total is off by a little. Grade on the identity (SKU/name/customer),
treat the dollar figure as approximate.

## Why it can't be shortcut
- **Year filter:** orders span 2024–2026; only 2025 counts (note the file names).
- **Status filter:** only \`fulfilled\`+\`delivered\` count — a model that assumes
  "fulfilled only" gets a different number, proving it read RETURNS_POLICY.md.
- **Three-way join:** revenue from the order files, name from products.json,
  top-customer name from customers.json.

## File sizes (each well under Read's ~25k-token page cap)
| file | chars | ~tokens |
|---|---:|---:|
${Object.entries(files).map(([n, c]) => `| ${n} | ${c.toLocaleString()} | ${Math.round(c / 1.91).toLocaleString()} |`).join("\n")}

Real per-request savings on this content: run \`node demo/preflight.mjs\`.
Your historical real savings: run \`node demo/analyze-events.mjs\`.
`);

console.log("demo data (compact json) written:");
let tot = 0; for (const [n, c] of Object.entries(files)) { tot += c; console.log(`  ${n.padEnd(22)} ${c.toLocaleString().padStart(8)} chars (~${Math.round(c / 1.91).toLocaleString()} tok)`); }
console.log(`  total ${tot.toLocaleString()} chars (~${Math.round(tot / 1.91).toLocaleString()} tok of bulk reads)`);
console.log(`\nground truth: ${winSku} "${winP.name}" net-2025 ≈ $${money(winCents).toLocaleString()}`);
console.log(`  top customer: ${custName.get(topCust)} (≈$${money(topCents).toLocaleString()}), margin over #2: $${money(winCents - runnerCents).toLocaleString()}`);
