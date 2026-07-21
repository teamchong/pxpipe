import { describe, it, expect } from 'vitest';
import { resolveLang, LOCALES, DEFAULT_LANG } from '../src/dashboard/i18n.js';
import { renderToggleFragment } from '../src/dashboard/fragments.js';

describe('resolveLang', () => {
  it('defaults to English with no cookie or header', () => {
    expect(resolveLang(undefined, undefined)).toBe('en');
    expect(resolveLang(undefined, undefined)).toBe(DEFAULT_LANG);
  });

  it('picks the language from Accept-Language when no cookie is set', () => {
    expect(resolveLang(undefined, 'it-IT,it;q=0.9,en;q=0.8')).toBe('it');
    expect(resolveLang(undefined, 'fr-FR,fr;q=0.9')).toBe('en'); // unregistered → default
  });

  it('an explicit pp-lang cookie overrides Accept-Language', () => {
    expect(resolveLang('pp-lang=it', 'en-US')).toBe('it');
    expect(resolveLang('foo=bar; pp-lang=en', 'it-IT')).toBe('en');
  });

  it('ignores a cookie value for an unregistered language', () => {
    expect(resolveLang('pp-lang=xx', 'it-IT')).toBe('it');
  });

  it('every registered locale is reachable', () => {
    expect(Object.keys(LOCALES)).toContain('en');
    expect(Object.keys(LOCALES)).toContain('it');
  });
});

describe('lang threading into fragments', () => {
  it('renders the Italian toggle fragment when lang=it', () => {
    const html = renderToggleFragment(true, 'it');
    expect(html).toContain('Compressione attiva');
    expect(html).not.toContain('Compression on');
  });

  it('still renders English by default (back-compat with existing tests)', () => {
    const html = renderToggleFragment(true);
    expect(html).toContain('Compression on');
  });
});
