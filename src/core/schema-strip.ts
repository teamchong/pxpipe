/**
 * Shared JSON-Schema annotation stripper for BOTH transformer paths
 * (Anthropic/Claude in transform.ts and OpenAI/GPT in openai.ts).
 *
 * The whole point of this module is that the strip is *structure-aware*: the
 * literal key `description` (also `title`, `default`, `examples`) is a schema
 * ANNOTATION in one place and a user-defined PROPERTY NAME in another. The
 * `task` tool, for example, has a required parameter literally named
 * `description`. A naive "drop every key called description" walk deletes that
 * property, leaving `required: ["description"]` pointing at nothing — the model
 * then can't emit it and the host rejects the tool call ("Missing key at
 * [\"description\"]"). So we only strip annotation keywords at the schema-node
 * level and recurse into the *values* of `properties`/`$defs`/etc., never
 * treating their keys as annotations.
 */

/** Max recursion depth for schema stripping. 20 handles realistic DSL/query schemas;
 *  deeper nodes are left untouched rather than corrupted. */
const SCHEMA_STRIP_MAX_DEPTH = 20;

/** Metadata keys that add tokens but no validation; the image carries them for the model.
 *  `$schema` is deliberately NOT here: it is the dialect declaration, not an annotation.
 *  Stripping it re-dialects the schema to the validator's default (JSON Schema 2020-12),
 *  which 400s draft-07 constructs the original legally used — e.g. tuple-form
 *  `items: [...]` in Voiceflow MCP tools ("tools.N.custom.input_schema: JSON schema
 *  is invalid. It must match JSON Schema draft 2020-12"). */
const SCHEMA_STRIP_KEYS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$id',
  '$comment',
]);

/** JSON Schema composition keys (values are arrays of subschemas). */
const SCHEMA_COMPOSITION_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);

/** JSON Schema keys whose values are named-subschema objects.
 *  IMPORTANT: the *keys* inside these objects are user property names, not
 *  annotation keywords — we recurse into the values only. */
const SCHEMA_NAMED_SUBSCHEMA_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
]);

/** JSON Schema keys whose value is a single subschema. */
const SCHEMA_SINGLE_SUBSCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'if',
  'then',
  'else',
]);

/** JSON Schema keys that are primitives or opaque arrays — pass through verbatim.
 *  `required`/`enum`/`const` MUST survive untouched: stripping a property while
 *  leaving its name in `required` is exactly the bug this module prevents. */
const SCHEMA_VERBATIM_KEYS = new Set([
  '$schema',        // dialect declaration; stripping it can invalidate the schema
  'required',
  'enum',
  'const',
  'type',          // string or array of strings
  '$ref',          // we don't resolve refs but we mustn't drop them
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
  'uniqueItems',
  'pattern',
]);

/** Real `format` tokens (date-time, uri, email…) are short; anything longer is a description. */
const FORMAT_MAX_LEN = 32;

/** Strip long-form metadata from a JSON Schema node, preserving the structural
 *  keys a tool-use validator needs. Strips: description, title, examples,
 *  default, $id, $comment, long format. Recurses into
 *  properties/oneOf/anyOf/allOf/items etc. Returns a fresh object — never
 *  mutates the input. Property *names* (the keys inside `properties` and
 *  friends) are preserved even when they collide with annotation keywords. */
export function stripSchemaDescriptions(node: unknown, depth = 0): unknown {
  if (depth > SCHEMA_STRIP_MAX_DEPTH) return node; // leave pathological depth untouched
  if (Array.isArray(node)) return node; // subschema arrays handled by parent
  if (!node || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (SCHEMA_STRIP_KEYS.has(k)) continue;

    if (k === 'format' && typeof v === 'string' && v.length > FORMAT_MAX_LEN) {
      continue; // long format = description in disguise
    }

    if (SCHEMA_VERBATIM_KEYS.has(k)) {
      out[k] = v;
      continue;
    }

    if (
      SCHEMA_NAMED_SUBSCHEMA_KEYS.has(k) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      const nested: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        nested[pk] = stripSchemaDescriptions(pv, depth + 1);
      }
      out[k] = nested;
      continue;
    }

    if (SCHEMA_COMPOSITION_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v.map((sub) => stripSchemaDescriptions(sub, depth + 1));
      continue;
    }

    if (SCHEMA_SINGLE_SUBSCHEMA_KEYS.has(k)) {
      // additionalProperties may be a boolean — pass through untouched.
      if (typeof v === 'boolean') {
        out[k] = v;
      } else if (Array.isArray(v)) {
        out[k] = v.map((sub) => stripSchemaDescriptions(sub, depth + 1));
      } else {
        out[k] = stripSchemaDescriptions(v, depth + 1);
      }
      continue;
    }

    // Unknown key — recurse into nested objects so vendor-extension descriptions get stripped.
    if (v && typeof v === 'object') {
      out[k] = stripSchemaDescriptions(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** JSON Schema keys that carry a parameter *contract* (shape/values), as opposed
 *  to pure annotations. Used to decide whether a stripped schema still tells the
 *  validator anything — if none survive, the strip is not worth shipping. */
export const SCHEMA_STRUCTURAL_KEYS = [
  'properties',
  'patternProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'items',
  '$ref',
  'enum',
  'const',
] as const;

/** True when the schema node retains at least one structural (contract) key. */
export function schemaHasStructure(schema: Record<string, unknown>): boolean {
  for (const k of SCHEMA_STRUCTURAL_KEYS) {
    if (k in schema) return true;
  }
  return false;
}
