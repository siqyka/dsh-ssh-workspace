"""Show "last used" on the host card, in both locales."""
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
    """      'editor.tags': '标签（可选，逗号分隔）',""",
    """      'hosts.lastUsed': '最近使用',
      'editor.tags': '标签（可选，逗号分隔）',""",
    'zh locale',
)

sub(
    """      'editor.tags': 'Tags (optional, comma separated)',""",
    """      'hosts.lastUsed': 'last used',
      'editor.tags': 'Tags (optional, comma separated)',""",
    'en locale',
)

sub(
    """          Array.isArray(host.tags) && host.tags.length > 0 && jsx('div', {
            className: 'sshwsp-host-tags',
            children: host.tags.map(tag => jsx('span', { key: tag, className: 'sshwsp-host-tag', children: tag })),
          }),""",
    """          Array.isArray(host.tags) && host.tags.length > 0 && jsx('div', {
            className: 'sshwsp-host-tags',
            children: host.tags.map(tag => jsx('span', { key: tag, className: 'sshwsp-host-tag', children: tag })),
          }),
          // The list is ordered recent-first, so a card that never says WHY it
          // is at the top makes the order look arbitrary — and a card with no
          // marker makes "the one I used ten minutes ago" indistinguishable
          // from one that has never been connected to.
          typeof host.lastUsedAt === 'number' && jsx('div', {
            className: 'sshwsp-host-lastused',
            children: `${t('hosts.lastUsed')} · ${formatRelativeTime(host.lastUsedAt)}`,
          }),""",
    'card row',
)

io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text)
print('patched', PATH)
