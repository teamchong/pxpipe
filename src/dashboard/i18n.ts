// Language registry for the dashboard. Adding a language is: write
// src/dashboard/locales/<code>.ts (implementing `Messages` from ./locales/en.js),
// then register it in LOCALES below. See docs/TRANSLATING.md.

import { en, type Messages } from './locales/en.js';
import { it } from './locales/it.js';

export const LOCALES = {
  en: { label: 'English', messages: en },
  it: { label: 'Italiano', messages: it },
} as const satisfies Record<string, { label: string; messages: Messages }>;

export type Lang = keyof typeof LOCALES;

export const DEFAULT_LANG: Lang = 'en';

const LANG_CODES = Object.keys(LOCALES) as Lang[];

function isLang(v: string): v is Lang {
  return (LANG_CODES as string[]).includes(v);
}

/** Read the `pp-lang` cookie out of a raw `Cookie` request header. */
function langFromCookie(cookieHeader: string | undefined): Lang | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== 'pp-lang') continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (isLang(value)) return value;
  }
  return undefined;
}

/** Pick the best registered locale out of an `Accept-Language` header, e.g.
 *  "it-IT,it;q=0.9,en;q=0.8" → 'it'. Falls back to DEFAULT_LANG. */
function langFromAcceptLanguage(header: string | undefined): Lang | undefined {
  if (!header) return undefined;
  const tags = header
    .split(',')
    .map((t) => t.split(';')[0]?.trim().toLowerCase())
    .filter((t): t is string => !!t);
  for (const tag of tags) {
    const base = tag.split('-')[0];
    if (base && isLang(base)) return base;
  }
  return undefined;
}

/** Resolve the dashboard's display language for one request. Precedence:
 *  explicit `pp-lang` cookie (set by the in-page language selector) beats the
 *  browser's `Accept-Language` negotiation, which beats DEFAULT_LANG. */
export function resolveLang(
  cookieHeader: string | undefined,
  acceptLanguageHeader: string | undefined,
): Lang {
  return langFromCookie(cookieHeader) ?? langFromAcceptLanguage(acceptLanguageHeader) ?? DEFAULT_LANG;
}

/** Message lookup for one language. */
export function t(lang: Lang): Messages {
  return LOCALES[lang].messages;
}

export type { Messages };
