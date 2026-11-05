import io

DOC = 'docs/optimization-and-future.md'
with io.open(DOC, encoding='utf-8') as handle:
    doc = handle.read()

OLD_ROW = "| F-08 | 本轮未动（界面细节，见下文） | 四条全部：文件浏览器动作、状态来源标注、新增文案走注册表、焦点管理纳入回归 |"
NEW_ROW = "| F-08 | 文件浏览器「复制路径 / 设为工作区根」、主机标签 UI、**状态来源标注**（live / cached / stale 三态），焦点管理已由 C-01 的 `useDialogA11y` 覆盖 | 「在远端任意子目录开终端」（宿主 `terminal/create` 没有 cwd 参数，做不了） |"

if doc.count(OLD_ROW) != 1:
    raise SystemExit('row count %d' % doc.count(OLD_ROW))
doc = doc.replace(OLD_ROW, NEW_ROW)

PROGRESS = """
**推进结果（本轮，状态来源标注）**：`/status` 这一次回复里混着三种年龄的事实——连接表是请求时读的，能力探测是可能比用户改主机更早的缓存，事件环按定义就是历史。三者用同一种方式渲染，等于隐含地说它们是同时观测到的；"说已连接但文件树是空的"正是这种混合产出的矛盾。

现在每一节都带 `{kind, at}`：`live`（应答时从运行中的系统读取）、`cached`（存下来的结果，带**存入**时间而不是服务时间）、`stale`（刷新失败、只剩最后一次成功的值）。判定在**服务端**算，因为缓存有多老只有缓存所在的那一层知道；浏览器若自己从时间戳推 TTL，两者会在第一次改 TTL 时分叉。面板只负责把它写成一句话。

三条不肯让步的细节：第四种 kind 会**抛**而不是默默变成一个没人渲染的类型；时钟偏移导致的负年龄夹到 0（渲染成"未来"会被读成面板的 bug）；**从未探测**不算 `stale`——那会让人去找一场没发生的失败。能力一节的年龄取**最旧**的一行，因为一节只和它最陈旧的那条一样新。

反向验证七个变异全红。其中一个最初是绿的，而且绿了两次：第一次我的断言只检查"调用存在"，于是把渲染改成 `false && ...` 之后仍然通过；第二次修好断言后，验证脚本又把 routes 套件整体当成"跳过"。后者暴露的是更普遍的问题——**部分跳过的套件曾被当作完全跳过**，而它恰恰是唯一跑着的那些断言。
"""

ANCHOR = "**验证**：键盘全流程可用；界面不出现"看起来是成功、其实是缓存"的状态。"
if doc.count(ANCHOR) != 1:
    raise SystemExit('anchor count %d' % doc.count(ANCHOR))
doc = doc.replace(ANCHOR, ANCHOR + "\n" + PROGRESS)

io.open(DOC, 'w', encoding='utf-8', newline='\n').write(doc)
print('patched')
