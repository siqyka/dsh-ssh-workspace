"""Add the relative-time formatter and the last-used style."""
import io

PATH = 'lib/client.js'
with io.open(PATH, encoding='utf-8') as handle:
    text = handle.read()


def sub(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit('%s: expected 1, found %d' % (label, count))
    text = text.replace(old, new)


sub(
    """      'hosts.lastUsed': '最近使用',""",
    """      'hosts.lastUsed': '最近使用',
      'hosts.lastUsed.justNow': '刚刚',
      'hosts.lastUsed.minutes': '{n} 分钟前',
      'hosts.lastUsed.hours': '{n} 小时前',
      'hosts.lastUsed.days': '{n} 天前',""",
    'zh time',
)

sub(
    """      'hosts.lastUsed': 'last used',""",
    """      'hosts.lastUsed': 'last used',
      'hosts.lastUsed.justNow': 'just now',
      'hosts.lastUsed.minutes': '{n} min ago',
      'hosts.lastUsed.hours': '{n} h ago',
      'hosts.lastUsed.days': '{n} d ago',""",
    'en time',
)

sub(
    """            children: `${t('hosts.lastUsed')} · ${formatRelativeTime(host.lastUsedAt)}`,""",
    """            children: `${t('hosts.lastUsed')} · ${relativeTimeText(t, host.lastUsedAt)}`,""",
    'card row',
)

sub(
    """.sshwsp-host-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }""",
    """.sshwsp-host-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sshwsp-host-lastused { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 4px; }""",
    'style',
)

# The formatter goes just before the style block, where the component's other
# module-level helpers already live.
sub(
    """.sshwsp { font-family: var(--dsw-font-family, system-ui, sans-serif);""",
    """/**
 * A coarse, translated "how long ago" for a host card.
 *
 * Deliberately coarse — minutes, hours, days — and never an absolute date.
 * The question the card answers is "is this the one I was just using?", and a
 * timestamp would make the reader do the subtraction themselves. Past a few days
 * the answer stops being useful for that question, so days is where it stops.
 *
 * `now` is injectable so a test can drive it without waiting.
 *
 * @param {(key: string, vars?: object) => string} t - the translator.
 * @param {number} at - epoch milliseconds.
 * @param {number} [now] - override for tests.
 * @returns {string} the phrase.
 */
function relativeTimeText (t, at, now) {
  const current = typeof now === 'number' ? now : Date.now()
  const seconds = Math.max(0, Math.round((current - at) / 1000))
  if (seconds < 60) return t('hosts.lastUsed.justNow')
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return t('hosts.lastUsed.minutes', { n: minutes })
  const hours = Math.max(1, Math.round(minutes / 60))
  if (hours < 24) return t('hosts.lastUsed.hours', { n: hours })
  return t('hosts.lastUsed.days', { n: Math.max(1, Math.round(hours / 24)) })
}

.sshwsp { font-family: var(--dsw-font-family, system-ui, sans-serif);""",
    'formatter',
)

io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text)
print('patched', PATH)
