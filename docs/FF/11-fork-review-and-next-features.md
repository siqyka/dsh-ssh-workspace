# 11 · fork 审阅与待建功能调查（已实施，方案页已归档）

> 这份调查已于 2026-11-27 全部实施：①展示文件、②主机硬停用（电源开关）、③会话命令行审查（审计 + 终端捕获 + 落盘）、④面板「审计」tab、⑤可配置保留条数。
>
> 按 `docs/FF/README.md` 的约定，方案页在实施后删除并把落点写回索引表；本文件因运行环境不允许删除文件而保留为指针页，内容已并入下列文档：
>
> - 功能与边界：`docs/features.md`（「展示文件」「主机硬停用（电源开关）」「命令审计」「终端击键捕获（近似）」「审计落盘」「保留条数与审计 tab」六行）
> - 界面语义与取舍：`docs/ui.md`（「文件行只是『这里有什么』」「卡片左侧的电源开关」「第四个 tab：审计是一张表，不是一个开关」三节）
> - 实现结构：`docs/architecture.md`（「主机硬停用（`lib/hosts/disable.js` + `engine.disabledHosts`）」与「命令审计的落盘与终端捕获」两节、42 条路由清单）
> - 变更记录：`CHANGELOG.md` 的 `## [未发布]`
> - 回归：`tests/host-disable-smoke.mjs`（49 项）、`tests/command-log-smoke.mjs`（78 项）、`tests/browser-rows-smoke.mjs`（28 项）
> - 手工冒烟：`docs/manual-test-checklist.md` 的 1.7b / 1.7c / 14.10–14.16
