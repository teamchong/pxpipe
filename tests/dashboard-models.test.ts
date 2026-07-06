import { describe, expect, it } from 'vitest';
import { renderModelsFragment } from '../src/dashboard/fragments.js';

describe('renderModelsFragment model chips', () => {
  it('keeps configured model IDs inside the hx-vals JSON model value', () => {
    const model = 'foo","evil":"bar';

    const html = renderModelsFragment([model], [model], true);

    const hxVals = [...html.matchAll(/hx-vals='([^']+)'/g)]
      .map((match) => match[1])
      .find((value) => value.includes('evil'));

    expect(hxVals).toBeDefined();

    const parsed = JSON.parse(hxVals!);

    expect(parsed).toEqual({
      model,
      on: false,
    });
  });
});
