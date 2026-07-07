/**
 * A crafted model id (attacker-controlled: it rides in as an `active` model
 * from a /v1/messages request on unauthenticated localhost) must not be able
 * to break out of the single-quoted hx-vals attribute or inject extra JSON
 * keys. See issue #58.
 */

import { describe, it, expect } from 'vitest';
import { renderModelsFragment } from '../src/dashboard/fragments.js';

describe('renderModelsFragment hx-vals escaping', () => {
  it('escapes crafted model ids so they cannot break out of the attribute', () => {
    // Double-quote → JSON injection; single-quote → attribute breakout.
    const evil = `foo","evil":"bar' onmouseover='alert(1)`;
    const html = renderModelsFragment([evil], [], true);

    // Raw quotes from the id never reach the attribute unescaped.
    expect(html).not.toContain(`"model":"${evil}"`);
    expect(html).not.toContain(`bar' onmouseover=`);

    // A well-formed id still renders its JSON value (as escaped entities that
    // the browser decodes back to valid JSON before htmx reads them).
    const ok = renderModelsFragment(['claude-fable-5'], [], true);
    expect(ok).toContain('&quot;model&quot;:&quot;claude-fable-5&quot;');
  });
});
