/**
 * `stripSchemaDescriptions` must enumerate every JSON Schema subschema container.
 *
 * The module's premise is that `description` is an annotation in one place and a
 * user property NAME in another, so it strips annotations only at schema-node
 * level and recurses into the *values* of the containers whose keys are property
 * names. That works for every container it lists. For one it does not list, the
 * walk falls through to the bottom of the loop, which has two fallbacks and both
 * are wrong for a container:
 *
 *   - an unknown key's OBJECT value is recursed into as if it were a schema node,
 *     so the container's property names are read as annotations and a subschema
 *     keyed `description` / `title` / `default` / `examples` is deleted outright;
 *   - an unknown key's ARRAY value is returned unchanged (arrays are handled by
 *     their parent), so annotations inside it are never stripped.
 *
 * Observed before the fix:
 *   dependentSchemas: {description: {required:['title']}}  ->  dependentSchemas: {}
 *   dependencies:     {description: ['title']}             ->  dependencies: {}
 *   dependentRequired:{description: ['title']}             ->  dependentRequired: {}
 *   prefixItems: [{type:'string', description:'…'}]        ->  description kept
 *
 * The three deletions are the same mistake as stripping a property named
 * `description`, one level up: the outbound tool schema silently loses a
 * validation constraint, so the model can emit a payload the real tool rejects.
 * `prefixItems` is the 2020-12 spelling of the tuple form this module already
 * handles as `items: [...]`, so its annotations shipped at text rates.
 *
 * Contract being verified:
 *   - A container keyed by a property name that collides with an annotation
 *     keyword keeps its subschema, in every such container.
 *   - Annotations nested inside those subschemas are still stripped.
 *   - Array-valued containers are walked, not passed through.
 *   - The containers that already worked keep working, and `required` / `enum` /
 *     `const` stay untouched.
 */

import { describe, expect, it } from 'vitest';

import { stripSchemaDescriptions } from '../src/core/schema-strip.js';

const strip = (s: unknown) => stripSchemaDescriptions(s) as Record<string, unknown>;

/** Every annotation keyword, so a container is tested against all of them, not
 *  just `description` — they are one Set in the implementation. */
const ANNOTATION_NAMES = ['description', 'title', 'default', 'examples'] as const;

describe('containers keyed by property names keep their subschemas', () => {
  describe.each(['dependentSchemas', 'dependencies'])('%s', (container) => {
    it.each(ANNOTATION_NAMES)('keeps a subschema keyed %s', (name) => {
      const out = strip({
        type: 'object',
        properties: { [name]: { type: 'string' }, other: { type: 'string' } },
        [container]: { [name]: { required: ['other'] } },
      });

      expect(out[container]).toEqual({ [name]: { required: ['other'] } });
    });
  });

  it.each(ANNOTATION_NAMES)('dependentRequired keeps the list keyed %s', (name) => {
    const out = strip({
      type: 'object',
      properties: { [name]: { type: 'string' }, other: { type: 'string' } },
      dependentRequired: { [name]: ['other'] },
    });

    expect(out['dependentRequired']).toEqual({ [name]: ['other'] });
  });

  it('strips annotations INSIDE a dependentSchemas subschema', () => {
    const out = strip({
      dependentSchemas: {
        description: { type: 'object', description: 'STRIP ME', required: ['x'] },
      },
    });

    expect(out['dependentSchemas']).toEqual({
      description: { type: 'object', required: ['x'] },
    });
  });

  it('accepts the draft-07 polymorphic dependencies value in both forms', () => {
    const out = strip({
      dependencies: {
        a: ['b'],
        c: { required: ['d'], description: 'STRIP ME' },
      },
    });

    expect(out['dependencies']).toEqual({ a: ['b'], c: { required: ['d'] } });
  });

  it('control: $defs and properties already behaved this way', () => {
    const out = strip({
      $defs: { description: { type: 'string', description: 'STRIP ME' } },
      properties: { title: { type: 'string', title: 'STRIP ME' } },
      $ref: '#/$defs/description',
      required: ['title'],
    });

    expect(out['$defs']).toEqual({ description: { type: 'string' } });
    expect(out['properties']).toEqual({ title: { type: 'string' } });
    expect(out['$ref']).toBe('#/$defs/description');
    expect(out['required']).toEqual(['title']);
  });
});

describe('array-valued containers are walked, not passed through', () => {
  it('strips annotations inside 2020-12 prefixItems', () => {
    const out = strip({
      type: 'array',
      prefixItems: [
        { type: 'string', description: 'STRIP ME', enum: ['a', 'b'] },
        { type: 'number', title: 'STRIP ME', minimum: 0 },
      ],
      items: false,
    });

    expect(out['prefixItems']).toEqual([
      { type: 'string', enum: ['a', 'b'] },
      { type: 'number', minimum: 0 },
    ]);
    expect(out['items']).toBe(false);
  });

  it('control: the draft-07 tuple spelling already worked', () => {
    const out = strip({
      type: 'array',
      items: [
        { type: 'string', description: 'STRIP ME' },
        { type: 'number', description: 'STRIP ME' },
      ],
    });

    expect(out['items']).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('recurses into a nested prefixItems', () => {
    const out = strip({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          prefixItems: [{ type: 'object', properties: { id: { type: 'string', description: 'STRIP ME' } } }],
        },
      },
    });

    expect(out['properties']).toEqual({
      rows: { type: 'array', prefixItems: [{ type: 'object', properties: { id: { type: 'string' } } }] },
    });
  });
});
