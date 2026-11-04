# 布局验收矩阵

> 目的：把「多尺寸 × 多布局不出横向滚动条、卡片不重叠、工具栏不越界、列表列不裁切、
> 设置行左右对齐」变成可重复执行的证据，而不是靠人工截图目测。
>
> 驱动：`scripts/verify-layout.mjs`（编排 `scripts/qa-user.mjs`）
> 对齐审计：`scripts/audit-alignment.mjs`
> 场景：`tests/ui/layout-900.json`、`tests/ui/layout-1440.json`、`tests/ui/columns-4.json`
> 种子：`tests/ui/fixtures/seed-data.json`（4 台连接，全部渲染）

---

## 1. 矩阵

### 1.1 短矩阵（默认，12 + 1 个用例）

| 视口 | grid-1 | grid-2 | grid-3 | grid-4 | list |
|---|---:|---:|---:|---:|---:|
| 900×620 | ✓ | ✓ | ✓ | – | ✓ |
| 1280×800 | – | – | ✓ | ✓ | – |
| 1440×900 | – | – | ✓ | ✓ | – |
| 1920×1080 | – | ✓ | ✓ | ✓ | ✓ |

外加 `1440×900 settings`：设置页行内「标签左缘 / 控件右缘」跨行对齐。

选择理由：
- 900 是产品宣称的最小窗口（内容区约 660px，三列必须降列）；
- 1280 是常见笔记本宽度，覆盖 grid-4 的降级边界；
- 1440/1920 验证 grid-4 真的排出 4 列，而不是「选了四列仍三列」；
- 列表在窄/宽两端各跑一次，覆盖可选列裁剪与表头对齐。

### 1.2 全矩阵（`--matrix full`，25 + 1）

5 个视口（900×620、1024×768、1280×800、1440×900、1920×1080）×
5 个布局（grid-1/2/3/4、list），外加设置页用例。用于发版前完整回归。

### 1.3 预期有效列数

内容区宽度 ≈ 视口宽度 − 侧栏 180 − 分隔条 ~4 − 内容区左右内边距 40 − 滚动条槽 ~15。
实际以运行时 `grid.getBoundingClientRect().width` 为准，下表是给人工核对的数量级：

| 视口 | 内容区≈ | grid-1 | grid-2 | grid-3 | grid-4 | list |
|---|---:|---:|---:|---:|---:|---|
| 900×620 | 660 | 1 | 2 | 2（降级） | 2（降级） | ✓ |
| 1024×768 | 785 | 1 | 2 | 3 | 3（降级） | ✓ |
| 1280×800 | 1040 | 1 | 2 | 3 | 3–4（边界） | ✓ |
| 1440×900 | 1200 | 1 | 2 | 3 | 4 | ✓ |
| 1920×1080 | 1680 | 1 | 2 | 3 | 4 | ✓ |

`1280 + grid-4` 正好卡在「容器 < 1040 最多 3 列」的阈值附近，因此校验器接受
3 或 4 列；视口 ≥ 1400 时 grid-4 **必须**是 4 列。

---

## 2. 降级规则（验收契约）

来源：`TopBar.tsx` 的四列菜单注释 + `ConnectionGrid` 的 `useElementWidth` 阈值。

| 容器宽度 | 允许多少列 |
|---|---|
| `< 520px` | 1 列 |
| `520–719px` | 至多 2 列 |
| `720–1039px` | 至多 3 列（grid-4 降为 3） |
| `≥ 1040px` | 按用户选择（grid-4 可 4 列） |

附加硬约束：

1. **任何尺寸下渲染列数都不得超过用户选择的列数**（禁止 auto-fill 擅自加列）；
2. 视口 `≥ 1400px` 且选择 grid-4 时必须渲染 4 列；
3. 900px 窗口选择 grid-3 必须降为 ≤2 列；
4. list 布局不受列数规则约束，但表头与每行单元格必须共用同一套列轨道。

---

## 3. 断言与选择器

所有断言都在渲染层真实 DOM 上执行（`Runtime.evaluate`），不读源码、不 mock。

| 对象 | 选择器 / 判定 | 断言 |
|---|---|---|
| 内容区 | `[data-scroll-root=true]` | `scrollWidth - clientWidth ≤ 1px` |
| 文档 | `documentElement.scrollWidth` / `body.scrollWidth` | 与 `innerWidth` 差 ≤ 1px |
| 卡片网格 | `div` 且 `display:grid`，直接子元素全部是 `role=button` 且有 `aria-label` | 取子元素最多的一个 |
| 卡片 | 上述网格的直接子元素 | 数量 = 种子 4；`width/height > 0`；两两相交面积 >1px 即失败；不得越出视口 |
| 渲染列数 | `getComputedStyle(grid).gridTemplateColumns` 按空白切分 | 与第 2 节规则比对 |
| 列表行 | `[data-row-index]` | 行数 = 种子 4；单元格尺寸 >0 |
| 列表表头 | 行容器的兄弟节点中 `display:grid` 的 sticky 表头 | 与每行按列比较 `left`/`width`，误差 ≤1px |
| 工具栏 | `header` 内 `button/input/[role=button]/[role=combobox]/[role=switch]` | 可见控件的 `left ≥ -1`、`right ≤ innerWidth+1` |
| 设置行 | `section[id^=settings-]` 内 `display:flex` + `justify-content:space-between` + 两个直接子元素 | 按标签左缘聚类，最大簇 ≥3 行；簇内 labelLeft / controlRight 极差 ≤2px |

说明：
- 设置页的 `SwitchRow` 是整行 `role=switch` 按钮，不参与「标签/控件」对齐断言；
  对齐断言针对 `Row` / `ActionRow`（左说明、右控件）结构。
- 卡片/列表的窗口化只渲染可视区，种子只有 4 条，所以全部可见；如换更大种子，
  需要把「数量」断言改成「至少可视行数」。

---

## 4. 证据路径

| 内容 | 路径 |
|---|---|
| 矩阵汇总 JSON | `.tmp/layout/summary.json` |
| 每个用例截图 | `.tmp/layout/<size>-<layout>.png`（如 `1440x900-grid-4.png`） |
| 每个用例生成的场景 | `.tmp/layout/steps/<size>-<layout>.json` |
| 对齐审计 JSON | `.tmp/audit/alignment.json` |
| 对齐审计截图 | `.tmp/audit/<size>-<layout>.png` |
| 功能场景截图 | `.tmp/ui-shots/run-<pid>-<ts>/<scenario>.png`（每次运行独立目录，避免并行覆盖） |
| 运行记录 | 控制台输出（`npm run verify:layout`） |

隔离约束：所有用例固定 `--user-data .tmp/layout-userdata`（每个用例启动前清空重建），
种子写入 `<user-data>/data.json`；**不读写真实 `%APPDATA%\rdpilot`**。

---

## 5. 运行方式

### 5.1 集成完成后（先构建）

```bat
npm run build
node scripts/verify-layout.mjs --dry-run
node scripts/verify-layout.mjs
node scripts/verify-layout.mjs --matrix full
node scripts/audit-alignment.mjs --win 1280x800 --layout grid-3
node scripts/audit-alignment.mjs --win 900x620 --layout grid-1
```

`--exe` 可指向打包产物（`release/win-unpacked/RDPilot.exe`）；
`--filter 900` 只跑 id 含 `900` 的用例；`--timeout` 是单用例总超时（默认 120s）。

### 5.2 单独跑功能场景

新场景按视口要求手动驱动（`scripts/verify-ui.mjs` 的固定清单未包含它们）：

```bat
node scripts/qa-user.mjs --steps tests/ui/layout-900.json --win 900x620 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/layout-1440.json --win 1440x900 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/columns-4.json --win 1920x1080 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/tags.json --win 1280x800 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/batch-edit.json --win 1280x800 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/session-panel.json --win 1280x800 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000

node scripts/qa-user.mjs --steps tests/ui/settings-session-tabs.json --win 1440x900 ^
  --user-data .tmp/scenario-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000
```

（在 Git Bash 里把行尾 `^` 换成 `\`，或写成一行。）

### 5.3 输出示例

```
PASS  900x620-grid-1  doc=0px root=0px cards=4 cols=1/1 container=660px overlaps=0 toolbarOverflow=0/14
PASS  900x620-grid-3  doc=0px root=0px cards=4 cols=2/3 container=660px overlaps=0 toolbarOverflow=0/14
PASS  1440x900-grid-4 doc=0px root=0px cards=4 cols=4/4 container=1201px overlaps=0 toolbarOverflow=0/18
FAIL  1440x900-grid-4 doc=0px root=0px cards=4 cols=3/4 container=1201px overlaps=0 toolbarOverflow=0/18
  FAIL 渲染列数 — cols=3/4 container=1201px — 视口 1440px ≥ 1400（grid-4 推荐宽度）→ 必须 4 列
```

---

## 6. 功能场景一览

| 场景 | 建议视口 | 断言 |
|---|---|---|
| `layout-900.json` | 900×620 | 三列在窄窗降为 ≤2 列；无横向溢出；卡片不重叠/不越界；工具栏不越界 |
| `layout-1440.json` | 1440×900 | grid-4 渲染 4 列；卡片与工具栏规则同上 |
| `columns-4.json` | 1920×1080 | grid-4 ↔ grid-2 切换；`settings.get` 持久化；列数随之变化 |
| `tags.json` | 1280×800 | 编辑抽屉新增标签 → 保存落库 → 筛选浮层按标签筛到 1 行 → 清除恢复 4 行 |
| `batch-edit.json` | 1280×800 | 选中 2 行 → 批量编辑加标签 → 应用后恰两条连接带标签 |
| `session-panel.json` | 1280×800 | 打开活动会话面板；无会话时显示空态；面板不越出视口；Esc 关闭 |
| `settings-session-tabs.json` | 1440×900 | 4 个标签信息开关 + 自动重连 + 窗口位置记忆逐项持久化，最后恢复原值 |

## 7. 已知限制

1. **视口来自 CDP 仿真**（`Emulation.setDeviceMetricsOverride`），不是物理改窗口；
   对布局断言的 `innerWidth/innerHeight` 与 CSS 视口是等价的，但不覆盖真实 DPI 缩放
   （125%/150%）和原生窗口边框。
2. **种子只有 4 条连接**：用于列数/重叠/对齐足够；不覆盖 200+ 条的滚动性能与窗口化。
   规模场景另有 `scripts/perf-fixture.mjs` / `scale-fixture.mjs`。
3. **grid-4 的 1040px 阈值**来自 `TopBar` 注释；若实现改用别的阈值，只需改
   `verify-layout.mjs` 里的 `columnExpectation()` 与本文第 2 节，保持文档与断言同源。
4. **会话面板空态**假定机器上没有未纳管的 mstsc 窗口；CI/干净环境稳定，
   开发机同时开着 mstsc 时该场景会按设计失败并打印实际面板文本。
5. **批量编辑**依赖 `SelectionBar` 的 `编辑` 按钮接线；若对话框尚未落地，
   场景会在「批量编辑对话框未打开」处失败并列出可用按钮。
6. 所有用例只使用隔离 userData 与文档保留地址，不发起真实 RDP 连接。
