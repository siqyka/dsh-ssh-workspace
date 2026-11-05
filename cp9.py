"""Fix the ordered-pattern fixture: a truly invalid pattern and a real \\b."""
import io

PATH = 'tests/command-confirm-smoke.mjs'
with io.open(PATH, encoding='utf-8') as handle:
    text = handle.read()

OLD = """  const ordered = {
    label: 'ordered',
    substrings: [],
    regexes: ['[unclosed', String.raw`\\brm\\b`],
  }"""

NEW = """  const ordered = {
    label: 'ordered',
    substrings: [],
    // `(unclosed` throws ("unterminated group"); `[unclosed` does NOT — a `[`
    // with no `]` is a literal in JS, which is why the first fixture silently
    // tested nothing. The second pattern is a real word-boundary match.
    regexes: ['(unclosed', '\\\\brm\\\\b'],
  }"""

if text.count(OLD) != 1:
    raise SystemExit('marker count %d' % text.count(OLD))
text = text.replace(OLD, NEW)

io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text)
print('patched')
