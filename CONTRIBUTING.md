# 参与开发

> 从 clone 到改动能跑起来，五分钟内。

## 环境

- Node.js **>= 20**（`package.json` 的 `engines`）。CI 跑 20；开发机上 22 / 24 也可以，但**别只在本机跑通就当过**——这个仓库曾因只在新版 Node 上测试，把一个 Node 20 不存在的 API 提交进去，导致发布会一直失败。
- 一个 DSH 安装（用于跑需要真实宿主的测试）。没有也能开发，见下文「三种测试」。

## 起步

```bash
git clone https://github.com/siqyka/dsh-ssh-workspace.git
cd dsh-ssh-workspace
npm ci
npm test
```

`npm ci` 只装 `ssh2`（唯一的运行期依赖）。`@deepseek-ai/*` 是宿主提供的 peer，**故意不从 registry 装**——装上会得到一份私有宿主副本，插件随即加载第二份 `dsh-fs`，症状是服务实例分裂。

## 三种测试

测试按「需要什么」分三层，`npm test` 会全跑，缺条件的那层自己 SKIP：

| 层 | 需要 | 覆盖 |
| --- | --- | --- |
| **纯逻辑** | 无 | 路径协议、客户端形状、围栏判定、传输、端口转发、存储锁 |
| **peer 依赖** | `@deepseek-ai/dsh-fs` 等 | 工具 schema、`ctx.fs` 接管、生命周期 |
| **真实主机** | `DSH_WS_TEST_ALIAS` | 远端 SFTP 全量契约、原子写、符号链接、终端 |

缺省情况下，后两层用一个自动生成的最小 stub 树跑（`tests/peer-stubs.mjs`），所以「裸检出也能跑大部分测试」。但 **stub 不验证宿主的强制 schema 子集**，这类断言只有真树能证明：

```bash
DSH_CORE_ROOT=/path/to/node_modules npm test
DSH_WS_TEST_ALIAS=myserver npm test          # 再加真实主机
```

`DSH_CORE_ROOT` 应指向一个含 `@deepseek-ai/*` 与 `ssh2` 的 `node_modules`，插件会用同一路径作 `DSH_PEER_ROOT`。

**注意一个历史陷阱**：这个仓库曾出现「测试全绿但功能坏了」，原因是缺陷只在被 SKIP 的套件里。看到一个 SKIP，先问「这层到底验证了什么」；宁可让它在 CI 里显式失败，也不要让它安静跳过。

这一点在 peer 检测器里有直接体现：`tests/support/peer-mode.mjs` 对每个包返回 `real` / `stub` / `absent` / `broken` 四态。**`broken`（装上了但加载失败）会让套件失败，不是跳过**——跳过一棵装坏的依赖树，等于给一个确实出错的环境发绿。检测器自己有 24 项测试（`tests/peer-mode-smoke.mjs`），因为它是所有 peer 套件的信任根，答错时没有别的套件会发现。

## 常用命令

```bash
npm run lint         # 语法检查 lib/ + scripts/ + tests/（只解析，不执行）
npm run check:docs   # 校验文档链接与锚点
npm test             # 全部套件
npm test routes boot # 只跑指定套件
npm run check        # lint + 文档 + 测试 + tarball 校验，提交前跑这个
```

单个套件也可以直接跑：`node tests/routes-smoke.mjs`。

## 代码约定

- **手写代码无构建步骤**，唯一例外是编辑器引擎 chunk。宿主半边是原生 ESM；浏览器半边是手写的主 bundle（`lib/client/client.js`）加同目录 chunk（`lib/client/client.*.js`，数量以 `scripts/client-map.mjs` 的 `clientParts()` 为准），由 DSH 前端的 `window.__ModuleLoader__.load({id, factory})` 约定直接加载。不要引入打包器——`client.editor-engine.js` 是 `npm run build:editor` 从 `editor-engine/` 生成的 CodeMirror 产物，`npm run check:editor` 防其漂移。
- **注释总体说明这个函数/功能做什么**，只在关键处写「为什么」、在容易出事的地方多写，尽量精简。凡是绕过宿主行为、依赖时序、或看起来可以简化但要出事的地方，必须留注释说明原因。不要留迁移史（「以前在哪个文件」），那是 CHANGELOG 的事。
- **`catch {}` 要么有注释，要么有日志。** 静默失败是这个插件最容易犯的错——远端与本机之间隔着网络，出错时不声不响会让人完全无法定位。
- **新增诊断信息走 `lib/core/diagnostics.js`，不要用 `ctx.logger.debug()`。** 宿主没有 console exporter，`debug` 级别低于所有 exporter 的默认级别，写进去等于没写。真正能被用户看到的是 `ssh_workspace_status` 工具和面板的 status 路由。
- **新增上游 workaround 必须登记。** 见 [docs/upstream-workarounds.md](./docs/upstream-workarounds.md)：可 grep 的稳定 id、自动退役、测试信号，三样缺一不可。

## 改完之后

1. `npm run check` 全绿（lint、编辑器产物校验、文档、client-map、测试、tarball）。
2. 改了 `lib/client/client.js`：重启 DSH 客户端，**在浏览器里实际点一遍**。客户端没有单元测试能覆盖渲染与手势。
3. 改了围栏、模式判定、或远端写入路径：在真实主机上验一次，并且验**反向**——把修复改回去，确认测试真的会红。这个仓库的若干次回归都是「测试没红，但功能坏了」。
4. 改了已发布行为：更新 [CHANGELOG](./CHANGELOG.md)，只写结论（原来坏在哪、现在怎么样），不写实现过程。

## 提交与发布

提交信息用 `fix:` / `docs:` / `chore:` 前缀，一个提交做一件事。发布流程见 [docs/development.md](./docs/development.md#打包与安装)，打包细节与 tag 校验都在那里。

## 行为准则

保持技术讨论的坦率，不针对个人。报告问题时假定对方是善意的。
