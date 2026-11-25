#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Three new directions: identical Rams palette, three different design skeletons."""
from pathlib import Path
import importlib.util

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("base_build", HERE / "build_demos.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

# Exact Rams palette — identical colour/token values across all three.
RAMS = r'''
body{
--stage:#e9eae7;--bg:#f7f7f5;--surface:#ffffff;--surface-2:#f0f1ee;--surface-3:#e8e9e5;
--card:#ffffff;--card-line:#d3d5d0;--border:#d8dad5;--border-strong:#c2c5bf;
--text:#191b1c;--muted:#595e61;--faint:#868b8d;
--accent:#1a5fb4;--accent-hover:#164e93;--on-accent:#fff;
--success:#0b6e46;--success-line:#a9cdb9;--success-soft:#eaf4ee;
--warn:#8a5a00;--warn-line:#d9bd85;--warn-soft:#fbf3e2;
--danger:#a52a20;--danger-line:#d7a8a3;--danger-soft:#fbecea;
--toast-bg:#fff;
--shadow:0 1px 2px rgba(20,22,20,.08),0 12px 32px rgba(20,22,20,.06);
--shadow-lg:0 8px 30px rgba(20,22,20,.18);
--font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--mono:ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
'''

# ---- A · 账本式：发丝线分栏的紧凑清单 ----
LEDGER = r'''
/* 风格 A · Ledger：没有卡片填充，只有发丝线与对齐的列——像一份可核对的主机清单 */
.panel{border:1px solid var(--border-strong);border-radius:3px}
.inner{padding:24px 22px}
.head h2{font-size:18px;letter-spacing:-.02em}
.head .sub{font-size:12px}
.tabs{margin:16px 0 14px;border-bottom:1px solid var(--border-strong)}
.tab{padding:9px 13px;font-size:13px}
.section-head{margin:20px 0 8px}
.section-head h3{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.provenance,.last,.note,.hint,.field-hint,.foot,.field-label{font-size:11px}
.card{background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:0;margin:0;padding:11px 2px}
.card:last-of-type{border-bottom:1px solid var(--border-strong)}
/* 左侧一道极细的索引刻度，给每行一个可扫读的起点，不用编号 */
.host-main{position:relative;padding-left:14px}
.host-main::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;background:var(--border-strong)}
.host-alias{font-size:13px;font-weight:650}
.addr{font-size:11px;color:var(--accent)}
.meta,.last{font-size:11px}
.chip,.pill{border-radius:2px;font-size:11px}
.actions{justify-content:flex-start}
.btn{border-radius:2px;font-size:11px;padding:4px 8px}
.mount,.fwd{background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:0;margin:0;padding:10px 2px}
.mount:last-child,.fwd:last-child{border-bottom:1px solid var(--border-strong)}
.mount-path{font-size:11px}
input,select{border-radius:2px;font-size:11px}
.mark{border-radius:2px}
.findings,.finding{font-size:11px}
'''

# ---- B · 分组面板：有衬底的分区、更宽的呼吸、两列字段 ----
PANELS = r'''
/* 风格 B · Panels：每个分区是一块浅色衬底面板，标题挂在左上角，行是独立小卡 */
.panel{border:1px solid var(--border);border-radius:8px}
.inner{padding:30px 28px}
.head h2{font-size:22px;letter-spacing:-.03em}
.head .sub{font-size:13px;margin-top:6px}
.tabs{margin:24px 0 22px;border-bottom:1px solid var(--border)}
.tab{padding:11px 16px;font-size:14px}
.section-head{margin:28px 0 12px}
.section-head h3{font-size:13px;font-weight:650;letter-spacing:0}
.card{background:var(--surface);border:1px solid var(--card-line);border-radius:7px;padding:16px 18px;margin-bottom:10px;box-shadow:0 1px 1px rgba(20,22,20,.02)}
.host{display:grid;grid-template-columns:1fr;gap:14px}
.host-alias{font-size:15px;font-weight:650}
.addr{font-size:12px;margin-top:5px}
.meta,.last,.note,.hint{font-size:12px}
.meta{margin-top:9px;gap:8px}
.note{margin-top:10px}
.chip,.pill{font-size:12px;padding:2px 9px}
.actions{padding-top:12px;border-top:1px solid var(--border);justify-content:flex-start}
.btn{padding:6px 12px;font-size:12px;border-radius:5px}
.mount,.fwd{background:var(--surface);border:1px solid var(--card-line);border-radius:7px;padding:14px 18px;margin-bottom:10px}
.mount-title{font-size:14px}
.mount-path{font-size:12px}
@media(min-width:700px){
  .form-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .forward-new{gap:8px}
}
input,select{border-radius:5px;font-size:12px;padding:7px 11px}
.field-label,.field-hint,.foot{font-size:12px}
.mark{border-radius:4px}
'''

# ---- C · 侧轨导航：tab 变成左侧竖排导航，内容在右 ----
RAIL = r'''
/* 风格 C · Rail：tab 移到左侧成为竖排导航，内容区独立——骨架层面的变化 */
.inner{display:grid;grid-template-columns:128px minmax(0,1fr);grid-template-rows:auto 1fr;column-gap:24px;padding:28px 24px}
.head{grid-column:1/-1;grid-row:1}
.head h2{font-size:19px;letter-spacing:-.02em}
.tabs{grid-column:1;grid-row:2;display:flex;flex-direction:column;gap:2px;margin:0;border-bottom:0;border-right:1px solid var(--border);padding:0 10px 0 0;overflow:visible}
.tab{height:auto;padding:9px 10px;font-size:13px;text-align:left;border-radius:3px;color:var(--muted)}
.tab:hover{background:var(--surface-2)}
.tab[aria-selected="true"]{background:var(--surface-3);font-weight:650;color:var(--text)}
.tab[aria-selected="true"]::after{left:0;right:auto;top:8px;bottom:8px;width:2px;height:auto;border-radius:2px}
.pane{grid-column:2;grid-row:2;min-width:0}
.section-head{margin:0 0 12px}
.section-head:not(:first-child){margin-top:26px}
.section-head h3{font-size:12px;font-weight:700;letter-spacing:.03em}
.card{background:var(--surface);border:1px solid var(--card-line);border-radius:5px;padding:12px 14px;margin-bottom:8px}
.host-alias{font-size:13px;font-weight:650}
.addr{font-size:11px}
.meta,.last,.note,.hint,.field-hint,.foot,.field-label{font-size:11px}
.chip,.pill{font-size:11px;border-radius:2px}
.actions{justify-content:flex-start}
.btn{font-size:11px;padding:4px 9px;border-radius:3px}
.mount,.fwd{background:var(--surface);border:1px solid var(--card-line);border-radius:5px;padding:11px 14px;margin-bottom:8px}
.mount-path{font-size:11px}
input,select{font-size:11px;border-radius:3px;padding:5px 8px}
.mark{border-radius:2px}
@media(max-width:620px){
  .inner{display:block;padding:24px 20px}
  .tabs{flex-direction:row;border-right:0;border-bottom:1px solid var(--border);padding:0 0 0;margin:16px 0 14px}
  .tab{text-align:center;padding:8px 11px}
  .tab[aria-selected="true"]::after{left:11px;right:11px;top:auto;bottom:-1px;width:auto;height:2px}
  .section-head:not(:first-child){margin-top:22px}
}
'''

for name, skeleton in [
    ('dir-rams-ledger', LEDGER),
    ('dir-rams-panels', PANELS),
    ('dir-rams-rail', RAIL),
]:
    html = base.MARKUP.replace('__THEME__', RAMS + '\n' + skeleton).replace('__DIRNAME__', name)
    (HERE / (name + '.html')).write_text(html, encoding='utf-8')
    print('wrote', name + '.html')
