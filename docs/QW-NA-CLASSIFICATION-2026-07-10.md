# Klasyfikacja statyczna QW01–QW10: N/A dla Claude Code (A/B 10QW cross-CLI)

Źródło: scout read-only na `feat/pxpipe-10qw-eval-34903197` (baza `9e43f1b` + cherry-picks `70289a4`, `3f2b0ac`), 2026-07-10.
Metodologia wg werdyktu debaty `debata-1783681887-2fda`: klasyfikacja statyczna (diff/grep zasięgu kodu) + 3 live spot-checki zamiast pełnej macierzy live po stronie Claude Code.

| QW | Klasyfikacja | Zasięg kodu (dowód) | Uwagi |
|---|---|---|---|
| QW01 | CROSS-CLI | `tracker.ts:1-160`; `proxy.ts:49-95` | telemetria netto (usage, cached_tokens, cache_create) wspólna; parser SSE/non-SSE w proxy |
| QW02 | OPENAI-ONLY → N/A | `openai-savings.ts:1-91` | profitability gate na tokenizerze `o200k_base`, logika stawek gpt-5; brak odpowiednika Anthropic |
| QW03 | CROSS-CLI | `schema-strip.ts:1-90` (klucze required verbatim: 62-80) | delta tool-schema stripper wspólny |
| QW04 | CROSS-CLI | `factsheet.ts:1-80` (wzorce ekstrakcji 19-32) | fact-sheet z budżetem tokenowym tier 0/1/2 |
| QW05 | CROSS-CLI | `openai-history.ts:99` + `history.ts:78` | adaptacyjna kompresja historii, `minCollapsePrefix=10` wspólny |
| QW06 | ZALEŻNY (patrz B06) | `openai-history.ts:150,238,257` | próg tokenowy nie jest OpenAI-specific; dla Claude testowalny SAMODZIELNIE; pomiar oszczędności OpenAI czeka na QW02 |
| QW07 | OPENAI-ONLY → N/A | `openai.ts` (`prompt_cache_key`); brak surface Claude w render/proxy | wg spec: N/A z dowodem + 3 live regresje |
| QW08 | CROSS-CLI | `render.ts` (framing/headers/guards); `transform.ts` | minifikacja framingu wspólna |
| QW09 | OPENAI-ONLY → N/A | `gpt-model-profiles.ts:1-80` (matching 66-99 gpt-only) | kalibracja profilu `gpt-5.6-sol` |
| QW10 | OPENAI-ONLY → N/A | `gpt-model-profiles.ts:27` (`GPT_MAX_HEIGHT_PX=1932`); Claude: `render.ts` `MAX_HEIGHT_PX=1568` hard-coded | wyrównanie wysokości strony OpenAI |

## Rozstrzygnięcie B06 (ryzyko otwarte #5 werdyktu)

B06 = A1+QW02+QW06 jest **zespołem OpenAI** (QW02 profitability + QW06 sweep progu wzajemnie zależne po stronie GPT).
Po stronie Claude Code: **QW06 samodzielny** (adaptacyjna historia dotyczy obu klientów), QW05/QW06 ortogonalne.
→ W macierzy: B06 werdykt łączny dla OpenAI; dla Claude QW06 raportowany samodzielnie.

## Spot-checki live cross-CLI (3, wg werdyktu)

1. **QW01** — parser usage SSE/non-SSE, `cached_tokens` w obu klientach.
2. **QW03** — required keys zachowane, enum/const nietknięte w obu.
3. **QW04** — tier-0 token drop + dedup vs schema w Anthropic i OpenAI.

## Konsekwencja dla macierzy 10×2

- Kolumna Claude Code: QW02, QW07, QW09, QW10 = **N/A z dowodem** (powyżej) + 3 live regresje (QW07 wg spec).
- Kolumna Claude Code live: QW01, QW03, QW04 (spot-checki) + QW05/QW06/QW08 wg wyników bramek OpenAI.
- Kolumna Codex/OpenAI: pełne B01–B10 + B-all.
