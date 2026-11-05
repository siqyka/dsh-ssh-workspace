"""Check the new progress line renders and the route carries provenance."""
import io

PATH = 'tests/client-shape-smoke.mjs'
with io.open(PATH, encoding='utf-8') as handle:
    text = handle.read()

OLD = "console.log(`\\n=== ${passed} passed, ${failures} failed ===`)"

NEW = """console.log('\\n[provenance] the panel admits how old the cached sections are')
{
  const source = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
  // The renderer must exist and be USED, not merely defined: a helper with no
  // call site renders nothing and reads as implemented.
  check('a provenance renderer exists', /function provenanceText/u.test(source))
  check('and the panel calls it', /provenanceText\\(t, status\\.provenance/.test(source),
    'no call site')
  check('the capability section is the one labelled',
    /status\\.provenance\\?\\.capabilities/u.test(source), 'capabilities not named')
  // Three kinds, three sentences: collapsing "stale" into "cached" would erase
  // the only distinction the user can act on (wait versus investigate).
  for (const key of ['provenance.live', 'provenance.cached', 'provenance.stale']) {
    const count = source.split(`'${key}'`).length - 1
    check(`${key} has a zh and an en entry`, count === 2, `found ${count}`)
  }
  // An unknown label must stay visible rather than rendering blank.
  check('an unknown kind falls through to the raw value',
    /return label\\.kind/u.test(source), 'no fallthrough')
}

console.log(`\\n=== ${passed} passed, ${failures} failed ===`)"""

if text.count(OLD) != 1:
    raise SystemExit('marker count %d' % text.count(OLD))
text = text.replace(OLD, NEW)

io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text)
print('patched')
