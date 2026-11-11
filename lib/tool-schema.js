/**
 * Projection and validation of a tool RESULT against its declared output schema.
 *
 * ## Why this module exists
 *
 * A tool declares `output.schema` and the Host now enforces it: the value is
 * first required to survive a lossless projection onto the schema, then each
 * property is checked against it. Two ways to fail, and both shipped:
 *
 *  1. an object returned with a key the schema does not declare, under
 *     `additionalProperties: false` → "…is not a declared property";
 *  2. an object carrying `undefined` (a row built with
 *     `description: entry.description` where the entry has none) → the value is
 *     not representable as JSON at all, so it is rejected before the property
 *     check ever runs, as "value is not lossless JSON".
 *
 * Both are the same mistake: an INTERNAL object was handed to the Host and the
 * schema was maintained separately by hand. The internal object is the source of
 * truth for the producer (`HostStore.listing()`, `ShellManager.list()`,
 * `Diagnostics.list()`) and has no reason to stop changing; the schema has no
 * reason to keep up. Nothing in the old test suite could notice, because it
 * compared TOP-LEVEL keys and only rendered hand-written values.
 *
 * ## The two-sided guarantee
 *
 * These two functions are deliberately in one module and are used by both halves:
 *
 *  - {@link projectValue} runs in the plugin, so a payload can never break a
 *    user's tool call — a field the schema forgot is dropped instead of failing
 *    the call;
 *  - {@link validateValue} runs in the tests and reports every drop, so the
 *    defence cannot become a place where information disappears silently.
 *
 * Dropping without a test is how the `skippedFiles` regression hid: the value
 * looked fine to the caller and the fact was simply gone. Dropping WITH a test
 * that fails on any drop makes the schema the thing that has to keep up.
 *
 * @module @shiqyka/dsh-ssh-workspace/tool-schema
 */

/** The type of a schema node, resolving the `oneOf` form used for `integer | null`. */
function typeOf (schema) {
  if (typeof schema !== 'object' || schema === null) return undefined
  if (typeof schema.type === 'string') return schema.type
  return undefined
}

/** Whether a value satisfies one branch of a `oneOf` list, by type only. */
function matchesType (type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    default: return true
  }
}

/** Join a path segment for an error message, so a nested fault is findable. */
function at (path, key) {
  return path === '' ? String(key) : `${path}.${key}`
}

/**
 * Keep only what the schema declares, recursively.
 *
 * Every dropped key is reported, including a declared key whose value is
 * `undefined`: the second case is not "undeclared", but it is equally fatal to
 * the result, because `undefined` has no JSON form. The caller's tests assert the
 * list is empty, so this is a safety net rather than a licence to leave the
 * schema behind.
 *
 * @param {object} schema - a raw JSON Schema node from an `output.schema`.
 * @param {*} value - the value the tool is about to return.
 * @param {string} [path] - dotted path, for the reported drops.
 * @param {Array<{path: string, reason: string}>} [dropped] - accumulator.
 * @returns {{value: *, dropped: Array<{path: string, reason: string}>}} the projection.
 */
export function projectValue (schema, value, path = '', dropped = []) {
  if (typeof schema !== 'object' || schema === null) return { value, dropped }
  if (value === undefined) return { value: undefined, dropped }

  // `oneOf` (used for `exitCode: integer | null`) has no properties of its own;
  // the value is a scalar and passes through untouched.
  if (Array.isArray(schema.oneOf)) return { value, dropped }

  const type = typeOf(schema)

  if (type === 'array') {
    if (!Array.isArray(value)) return { value, dropped }
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
    const projectedItems = value.map((entry, index) =>
      projectValue(items, entry, `${path}[${index}]`, dropped).value)
    return { value: projectedItems, dropped }
  }

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value, dropped }
    // A free-form object (no `properties`) is passed through: there is nothing
    // to project onto, and inventing a whitelist would drop real data.
    if (typeof schema.properties !== 'object' || schema.properties === null) return { value, dropped }
    const projected = {}
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      const next = value[key]
      if (next === undefined) {
        // Declared-but-absent is normal for an optional field. Declared-and-
        // explicitly-undefined is the "not lossless JSON" failure: the key
        // exists on the object, so it would be serialised as `undefined`.
        if (Object.hasOwn(value, key)) dropped.push({ path: at(path, key), reason: 'undefined (not representable in JSON)' })
        continue
      }
      projected[key] = projectValue(propertySchema, next, at(path, key), dropped).value
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(schema.properties, key)) continue
        // Reported even when the value is `undefined`. Such a key is discarded
        // either way (it is not copied below), and an unreported discard is the
        // exact failure this module exists to prevent: the payload loses a field
        // and every surface still looks healthy.
        dropped.push({ path: at(path, key), reason: 'not declared in the output schema' })
      }
    } else {
      // A schema that does NOT forbid extra properties allows them, so dropping
      // them here would remove data the Host would have accepted — a silent
      // downgrade of the tool, not a fix for it.
      for (const [key, next] of Object.entries(value)) {
        if (Object.hasOwn(schema.properties, key)) continue
        if (next === undefined) continue
        projected[key] = next
      }
    }
    return { value: projected, dropped }
  }

  return { value, dropped }
}

/**
 * Check one value against its declared output schema.
 *
 * Covers the subset this plugin actually uses — object properties, required,
 * additionalProperties, arrays with items, scalars, and `oneOf` — rather than
 * pulling in a dependency. Anything wider would be a second JSON Schema
 * implementation to keep honest; this one is only asked "would the Host accept
 * this result?", and the Host's own `assertSupportedJsonSchema` already polices
 * which constructs can appear at all.
 *
 * @param {object} schema - a raw JSON Schema node.
 * @param {*} value - the value to check.
 * @param {string} [path] - dotted path, for the error message.
 * @returns {string[]} one line per problem; empty means valid.
 */
export function validateValue (schema, value, path = '') {
  if (typeof schema !== 'object' || schema === null) return []
  const label = path === '' ? 'value' : path

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch) => {
      const type = typeOf(branch)
      return type === undefined ? true : matchesType(type, value)
    })
    return matched ? [] : [`${label} matches none of the declared oneOf branches (got ${describe(value)})`]
  }

  const type = typeOf(schema)
  if (type !== undefined && !matchesType(type, value)) {
    return [`${label} should be ${type} but is ${describe(value)}`]
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return []
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
    return value.flatMap((entry, index) => validateValue(items, entry, `${label}[${index}]`))
  }

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const errors = []
    const properties = schema.properties ?? {}
    const required = Array.isArray(schema.required) ? schema.required : []
    // The author-facing spec also marks a property `required: true` inside the
    // property itself; both spellings are honoured because `defineTool` may pass
    // either through to the value the Host validates.
    for (const [key, propertySchema] of Object.entries(properties)) {
      const missing = !Object.hasOwn(value, key) || value[key] === undefined
      if (propertySchema?.required === true && missing) {
        errors.push(`${at(label, key)} is required but absent`)
        continue
      }
      if (missing) continue
      errors.push(...validateValue(propertySchema, value[key], at(label, key)))
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${at(label, key)} is required but absent`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue
        errors.push(`${at(label, key)} is not a declared property (additionalProperties: false)`)
      }
    }
    return errors
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${label} should be one of ${JSON.stringify(schema.enum)} but is ${describe(value)}`]
  }

  return []
}

/** Describe a value for an error message without dumping an entire object. */
function describe (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (typeof value === 'object') return `an object with keys ${JSON.stringify(Object.keys(value).slice(0, 6))}`
  return `${typeof value} ${JSON.stringify(value)}`
}
