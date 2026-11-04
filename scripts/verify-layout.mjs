#!/usr/bin/env node
/**
 * 多尺寸 × 多布局验收矩阵（真机 Electron + CDP + 截图 + JSON 证据）。
 *
 * 用法：
 *   node scripts/verify-layout.mjs --dry-run          # 只生成场景并做语法检查
 *   node scripts/verify-layout.mjs                    # 12 个代表性用例 + 设置页
 *   node scripts/verify-layout.mjs --matrix full      # 5 尺寸 × 5 布局 = 25 + 设置页
 *   node scripts/verify-layout.mjs --filter 900       # 只跑 id 含 900 的用例
 *   node scripts/verify-layout.mjs --exe release/win-unpacked/RDPilot.exe
 *
 * 每个用例：
 *   1. 用隔离 userData（.tmp/layout-userdata）和固定种子（tests/ui/fixtures/seed-data.json）
 *      启动应用；绝不读写真实 %APPDATA%\rdpilot；
 *   2. 在场景里调用 window.api.settings.update({ layout }) 切布局；
 *   3. 测量文档/内容区横向溢出、工具栏控件越界、卡片数量/尺寸/两两重叠、
 *      渲染列数、列表表头与行单元格的每列 x/width 对齐；
 *   4. 设置页用例额外测量行内「标签左缘 / 控件右缘」跨行对齐；
 *   5. 截图 → .tmp/layout/<size>-<layout>.png；
 *   6. 汇总 → .tmp/layout/summary.json，逐条 PASS/FAIL 并打印精确数字，失败退出 1。
 *
 * 断言口径（详见 docs/LAYOUT-TEST-MATRIX.md）：
 *   - 渲染列数不得超过用户选择的列数；
 *   - 容器 < 520px → 1 列；< 720px → 最多 2 列；grid-4 在 < 1040px → 最多 3 列；
 *   - 宽容器（≥1280px）下 grid-4 必须真的排出 4 列；
 *   - 所有尺寸都允许「按降级规则变少」，但不允许「比用户选的多」。
 *
 * 依赖：应用已构建（out/main/index.js）且 node_modules/electron 存在。
 * 本脚本只编排 qa-user.mjs，不修改任何应用源码/设置文件。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Node 侧冷却（页面内的 sleep 在 eval 字符串里，不共享作用域） */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DRY_RUN = argv.includes('--dry-run')
const MATRIX = argOf('matrix', 'short')
const FILTER = argOf('filter', null)
const EXE = argOf('exe', null)
const TIMEOUT = Number(argOf('timeout', '120000'))
/**
 * 不传 --port 时由 qa-user 自动 listen(0) 分配空闲端口：
 * 固定基址（旧行为 9410+index）只在本脚本内部不重复，与并行运行的其他验收仍会撞。
 * 显式传 --port 时沿用"基址 + 用例序号"的老行为。
 */
const BASE_PORT = argOf('port', null)
/**
 * 按映像名清理只能用在独占的 CI 机器上：它会杀掉并行运行的另一套验收
 * （以及人工开着的实例）。默认关闭，qa-user 已按 PID 结束自己的进程树。
 */
const FORCE_CLEAN = argv.includes('--force-clean')
const OUT_DIR = resolve(ROOT, '.tmp/layout')
const STEPS_DIR = resolve(OUT_DIR, 'steps')
const USER_DATA = resolve(ROOT, '.tmp/layout-userdata')
const SEED = resolve(ROOT, 'tests/ui/fixtures/seed-data.json')
const QA_USER = resolve(ROOT, 'scripts/qa-user.mjs')
/** 种子数据里的连接数：q=4（全部渲染，窗口化不会裁掉） */
const SEED_COUNT = 4

const SIZES = ['900x620', '1024x768', '1280x800', '1440x900', '1920x1080']
const GRID_LAYOUTS = ['grid-1', 'grid-2', 'grid-3', 'grid-4']
const ALL_LAYOUTS = [...GRID_LAYOUTS, 'list']

/**
 * 代表性短矩阵：窄窗（900）验证降列、1280/1440 验证 grid-4 生效、
 * 1920 验证宽屏满列；列表在 900/1920 两端各跑一次。
 */
const SHORT_CASES = [
  ['900x620', 'grid-1'],
  ['900x620', 'grid-2'],
  ['900x620', 'grid-3'],
  ['900x620', 'list'],
  ['1280x800', 'grid-3'],
  ['1280x800', 'grid-4'],
  ['1440x900', 'grid-3'],
  ['1440x900', 'grid-4'],
  ['1920x1080', 'grid-2'],
  ['1920x1080', 'grid-3'],
  ['1920x1080', 'grid-4'],
  ['1920x1080', 'list']
]

if (MATRIX !== 'short' && MATRIX !== 'full') {
  console.error(`--matrix 只支持 short / full，收到: ${MATRIX}`)
  process.exit(2)
}

/* --------------------------- 用例构建 --------------------------- */

function buildCases() {
  const cases = []
  if (MATRIX === 'full') {
    for (const size of SIZES) {
      for (const layout of ALL_LAYOUTS) cases.push({ size, layout, kind: 'layout' })
    }
  } else {
    for (const [size, layout] of SHORT_CASES) cases.push({ size, layout, kind: 'layout' })
  }
  // 设置页行对齐只跑一次：1440×900（双列设置网格真正生效的宽度）
  cases.push({ size: '1440x900', layout: 'settings', kind: 'settings' })
  for (const item of cases) {
    item.id = `${item.size}-${item.layout}`
    const [w, h] = item.size.split('x').map(Number)
    item.viewport = { width: w, height: h }
  }
  return FILTER ? cases.filter((item) => item.id.includes(FILTER)) : cases
}

const CASES = buildCases()
if (CASES.length === 0) {
  console.error(`--filter ${FILTER} 没有匹配任何用例`)
  process.exit(2)
}

/* --------------------------- 场景表达式 --------------------------- */

/** 卡片网格/列表/溢出/工具栏的测量脚本：永远返回 JSON 字符串，避免 qa-user 打印多行对象 */
function layoutEvalExpression(layout) {
  const requested = layout.startsWith('grid-') ? Number(layout.slice('grid-'.length)) : 0
  return `(async () => {
  const layout = ${JSON.stringify(layout)};
  const requested = ${requested};
  const seedCount = ${SEED_COUNT};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: +r.left.toFixed(2), top: +r.top.toFixed(2),
      right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2),
      width: +r.width.toFixed(2), height: +r.height.toFixed(2)
    };
  };
  const isGrid = (el) => getComputedStyle(el).display === 'grid';
  // Chrome 的 computed gridTemplateColumns 会解析成像素轨道；repeat() 兜底只为老内核/异常情况
  const countTracks = (value) => {
    const repeat = String(value).match(/^repeat\\((\\d+),/);
    if (repeat) return Number(repeat[1]);
    return String(value).split(/\\s+/).filter(Boolean).length;
  };
  const result = { layout, requested, mode: layout === 'list' ? 'list' : 'grid', ok: false };
  try {
    const updated = await window.api.settings.update({ layout });
    if (!updated || updated.ok !== true) {
      throw new Error('settings.update 失败: ' + JSON.stringify(updated));
    }
    const root = document.querySelector('[data-scroll-root="true"]');
    if (!root) throw new Error('找不到内容区滚动容器 [data-scroll-root="true"]');

    const findCardGrid = () => {
      const candidates = Array.from(root.querySelectorAll('div')).filter((el) => {
        if (!isGrid(el)) return false;
        const kids = Array.from(el.children).filter((kid) => kid.getAttribute('aria-hidden') !== 'true');
        if (kids.length === 0) return false;
        return kids.every((kid) => kid.getAttribute('role') === 'button' && (kid.getAttribute('aria-label') || '').length > 0);
      });
      candidates.sort((a, b) => b.children.length - a.children.length);
      return candidates[0] || null;
    };
    const findAllRows = () => Array.from(root.querySelectorAll('[data-row-index]'));

    if (layout === 'list') {
      let rows = [];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        rows = findAllRows();
        if (rows.length >= seedCount) break;
        await sleep(80);
      }
      await sleep(250);
      rows = findAllRows();
      if (rows.length < seedCount) {
        throw new Error('列表行数不足：期望至少 ' + seedCount + '，实际 ' + rows.length);
      }
      const body = rows[0].parentElement;
      const container = body ? body.parentElement : null;
      const header = body && container
        ? Array.from(container.children).find((el) => el !== body && isGrid(el) && el.getBoundingClientRect().width > 0)
        : null;
      if (!header) throw new Error('找不到列表表头（sticky grid）');
      const headerCells = Array.from(header.children).map(rectOf);
      const rowCellSets = rows.map((row) => Array.from(row.children).map(rectOf));
      const cellCount = Math.min(headerCells.length, ...rowCellSets.map((cells) => cells.length));
      const columns = [];
      for (let index = 0; index < cellCount; index += 1) {
        const dx = Math.max(...rowCellSets.map((cells) => Math.abs(cells[index].left - headerCells[index].left)));
        const dw = Math.max(...rowCellSets.map((cells) => Math.abs(cells[index].width - headerCells[index].width)));
        columns.push({
          column: index,
          dx: +dx.toFixed(2),
          dw: +dw.toFixed(2),
          pass: dx <= 1 && dw <= 1
        });
      }
      result.rows = rows.length;
      result.headerCells = headerCells.length;
      result.rowCellCounts = rowCellSets.map((cells) => cells.length);
      result.listColumns = columns;
      result.columnCount = Math.min(headerCells.length, ...rowCellSets.map((cells) => cells.length));
      result.zeroSizeRows = rowCellSets
        .map((cells, rowIndex) => ({ cells, rowIndex }))
        .filter((entry) => entry.cells.some((cell) => cell.width <= 0 || cell.height <= 0))
        .map((entry) => entry.rowIndex);
      result.zeroSizeCells = rowCellSets
        .map((cells, rowIndex) =>
          cells
            .map((cell, cellIndex) => ({ cellIndex, width: cell.width, height: cell.height }))
            .filter((cell) => cell.width <= 0 || cell.height <= 0)
            .map((cell) => ({ rowIndex, ...cell }))
        )
        .flat();
    } else {
      let grid = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        grid = findCardGrid();
        if (grid && grid.children.length === seedCount) break;
        await sleep(80);
      }
      await sleep(250);
      grid = findCardGrid();
      if (!grid) {
        throw new Error('找不到卡片网格（display:grid 且直接子元素都是 role=button 的容器）');
      }
      const cards = Array.from(grid.children).map(rectOf);
      const template = getComputedStyle(grid).gridTemplateColumns;
      const columns = countTracks(template);
      const containerRect = rectOf(grid);
      const overlaps = [];
      for (let a = 0; a < cards.length; a += 1) {
        for (let b = a + 1; b < cards.length; b += 1) {
          const horizontal = Math.min(cards[a].right, cards[b].right) - Math.max(cards[a].left, cards[b].left);
          const vertical = Math.min(cards[a].bottom, cards[b].bottom) - Math.max(cards[a].top, cards[b].top);
          if (horizontal > 1 && vertical > 1) {
            overlaps.push({ a, b, horizontal: +horizontal.toFixed(2), vertical: +vertical.toFixed(2) });
          }
        }
      }
      result.gridTemplateColumns = template;
      result.columns = columns;
      result.containerWidth = containerRect.width;
      result.cardCount = cards.length;
      result.cards = cards;
      result.zeroSizeCards = cards
        .map((card, index) => ({ card, index }))
        .filter((entry) => entry.card.width <= 0 || entry.card.height <= 0)
        .map((entry) => entry.index);
      result.overlaps = overlaps;
      result.cardOutOfViewport = cards
        .map((card, index) => ({ card, index }))
        .filter((entry) => entry.card.left < -1 || entry.card.right > window.innerWidth + 1)
        .map((entry) => entry.index);
    }

    result.viewport = { width: window.innerWidth, height: window.innerHeight };
    result.documentOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    result.rootOverflow = root.scrollWidth - root.clientWidth;
    result.rootClientWidth = root.clientWidth;

    const topbar = document.querySelector('header');
    if (!topbar) {
      result.toolbar = { pass: false, error: '找不到顶栏 <header>' };
    } else {
      const controls = Array.from(topbar.querySelectorAll('button, input, [role="button"], [role="combobox"], [role="switch"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((el) => ({
          label: (el.getAttribute('aria-label') || el.innerText || el.tagName).trim().slice(0, 32),
          ...rectOf(el)
        }));
      const overflowing = controls.filter((control) =>
        control.left < -1 || control.right > window.innerWidth + 1 || control.bottom > window.innerHeight + 1
      );
      result.toolbar = {
        total: controls.length,
        overflowing,
        pass: overflowing.length === 0 && controls.length > 0
      };
    }
    result.ok = true;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }
  return JSON.stringify(result);
})()`
}

/** 设置页行对齐：取 #settings-window 分节里的 Row（flex + space-between + 两个直接子元素） */
function settingsEvalExpression() {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: +r.left.toFixed(2), top: +r.top.toFixed(2),
      right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2),
      width: +r.width.toFixed(2), height: +r.height.toFixed(2)
    };
  };
  const result = { mode: 'settings', ok: false, rows: [], groups: [] };
  try {
    const root = document.querySelector('[data-scroll-root="true"]');
    if (!root) throw new Error('找不到内容区滚动容器 [data-scroll-root="true"]');
    const deadline = Date.now() + 6000;
    let sections = [];
    while (Date.now() < deadline) {
      sections = Array.from(document.querySelectorAll('section[id^=settings-]'));
      if (sections.length >= 5) break;
      await sleep(100);
    }
    if (sections.length === 0) throw new Error('找不到设置分节（是否已进入设置页？）');
    await sleep(350);

    const scopes = sections;
    /*
     * R11：控件槽在详情行（有说明时）或标题行（无说明时）——两者都算同一行的
     * label/control 对，所以扫 row 而不是 .rp-setting-line。
     */
    const candidates = [];
    for (const section of scopes) {
      for (const el of Array.from(section.querySelectorAll('[data-setting-row="true"].rp-setting-row'))) {
        const label = el.querySelector('[data-setting-label="true"]')
        const slot = el.querySelector('[data-setting-slot="true"]')
        if (!label || !slot) continue
        const rect = el.getBoundingClientRect()
        if (rect.height < 10 || rect.width < 200) continue
        const first = label.getBoundingClientRect()
        const second = slot.getBoundingClientRect()
        if (first.width <= 0 || second.width <= 0) continue
        if (first.right >= second.right) continue // 堆叠模式（窄窗）不算横向行
        candidates.push(el)
      }
    }
    const rows = candidates.filter((el) => !candidates.includes(el.parentElement));
    if (rows.length < 3) {
      throw new Error('设置行不足 3 条（找到 ' + rows.length + ' 条 flex/space-between 行）');
    }
    result.rows = rows.map((el) => {
      // R10：直接取 label/slot 元素（槽可能在详情行，也可能兜底在标题行）
      const labelEl = el.querySelector('[data-setting-label="true"]');
      const slotEl = el.querySelector('[data-setting-slot="true"]');
      const label = rectOf(labelEl);
      const control = rectOf(slotEl);
      const row = rectOf(el);
      return {
        label: (labelEl.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 28),
        labelLeft: label.left,
        controlRight: control.right,
        rowLeft: row.left,
        rowRight: row.right,
        rowWidth: row.width,
        controlInsideRow: control.right <= row.right + 1 && control.left >= row.left - 1
      };
    });

    /*
     * 按「标签左缘 + 行右缘」聚类，而不是只按标签左缘：
     * 设置页有双列网格（左列行宽 403px、右列行宽 403px、整宽行 838px），
     * 左列行与整宽行的 labelLeft 相同但右缘不同，只按 labelLeft 会把它们混成一组，
     * 报出 400px+ 的 controlSpread 假阳性。真正该对齐的是同一卡片列内的右缘。
     */
    const sortedRows = result.rows
      .slice()
      .sort((a, b) => a.labelLeft - b.labelLeft || a.rowRight - b.rowRight);
    const clusters = [];
    for (const row of sortedRows) {
      const last = clusters[clusters.length - 1];
      if (
        last &&
        Math.abs(row.labelLeft - last[0].labelLeft) <= 2 &&
        Math.abs(row.rowRight - last[0].rowRight) <= 2
      ) {
        last.push(row);
      } else {
        clusters.push([row]);
      }
    }
    result.groups = clusters
      .map((grouped) => {
        const labelLefts = grouped.map((row) => row.labelLeft);
        const controlRights = grouped.map((row) => row.controlRight);
        const labelSpread = +(Math.max(...labelLefts) - Math.min(...labelLefts)).toFixed(2);
        const controlSpread = +(Math.max(...controlRights) - Math.min(...controlRights)).toFixed(2);
        return {
          labelLeft: +grouped[0].labelLeft.toFixed(2),
          count: grouped.length,
          labelSpread,
          controlSpread,
          controlInside: grouped.every((row) => row.controlInsideRow),
          pass: grouped.length >= 2 && labelSpread <= 2 && controlSpread <= 2 && grouped.every((row) => row.controlInsideRow)
        };
      })
      .sort((a, b) => b.count - a.count);

    const largest = result.groups[0];
    result.alignment = {
      rowCount: result.rows.length,
      groups: result.groups.length,
      largestGroup: largest ? largest.count : 0,
      labelSpread: largest ? largest.labelSpread : null,
      controlSpread: largest ? largest.controlSpread : null,
      pass: Boolean(largest && largest.count >= 3 && largest.pass)
    };
    result.viewport = { width: window.innerWidth, height: window.innerHeight };
    result.documentOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    result.rootOverflow = root.scrollWidth - root.clientWidth;
    result.rootClientWidth = root.clientWidth;
    result.ok = true;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }
  return JSON.stringify(result);
})()`
}

/* --------------------------- 期望列数 --------------------------- */

/**
 * 与 LAYOUT-TEST-MATRIX.md 写死的降级契约一致：
 *   < 520  → 1；< 720 → min(requested, 2)；grid-4 且 < 1040 → min(requested, 3)。
 * 返回 { ok, expected, note }。宽容器 grid-4 用容器宽度判定，避开 1280 窗口
 * 在滚动条宽度下的边界抖动。
 */
function columnExpectation(requested, actual, containerWidth, viewportWidth) {
  if (!requested) return { ok: true, expected: null, note: 'n/a' }
  if (actual > requested) {
    return { ok: false, expected: requested, note: `渲染 ${actual} 列超过用户选择 ${requested} 列` }
  }
  if (containerWidth < 520) {
    return { ok: actual === 1, expected: 1, note: `容器 ${containerWidth}px < 520 → 必须 1 列` }
  }
  if (containerWidth < 720) {
    return {
      ok: actual <= 2,
      expected: Math.min(requested, 2),
      note: `容器 ${containerWidth}px < 720 → 最多 2 列`
    }
  }
  if (requested >= 4 && containerWidth < 1040) {
    return {
      ok: actual <= 3,
      expected: Math.min(requested, 3),
      note: `容器 ${containerWidth}px < 1040 → grid-4 最多 3 列`
    }
  }
  if (requested >= 4 && viewportWidth >= 1400) {
    return {
      ok: actual === 4,
      expected: 4,
      note: `视口 ${viewportWidth}px ≥ 1400（grid-4 推荐宽度）→ 必须 4 列`
    }
  }
  if (requested >= 4) {
    // 1280 窗口按容器规则合法的结果是 3；若实现按窗口宽度排 4 也接受。
    return {
      ok: actual === 3 || actual === 4,
      expected: '3–4',
      note: `视口 ${viewportWidth}px 处于 grid-4 边界，允许 3–4 列（容器 ${containerWidth}px）`
    }
  }
  return {
    ok: actual === requested,
    expected: requested,
    note: `容器 ${containerWidth}px ≥ 720 → 必须 ${requested} 列`
  }
}

/* --------------------------- 逐用例执行 --------------------------- */

function makeSteps(testCase) {
  const shot = `.tmp/layout/${testCase.id}.png`
  if (testCase.kind === 'settings') {
    return {
      wait: 3500,
      steps: [
        { clickText: '设置' },
        { wait: 900 },
        { eval: settingsEvalExpression() },
        { wait: 200 },
        { shot }
      ]
    }
  }
  return {
    wait: 3500,
    steps: [
      { eval: layoutEvalExpression(testCase.layout) },
      { wait: 200 },
      { shot }
    ]
  }
}

/** qa-user 把 eval 结果打印成 `[step N] eval → <JSON>`；这里还原两层 JSON */
function parseEvalOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (const line of lines) {
    const marker = line.indexOf(' eval → ')
    if (marker < 0) continue
    const payload = line.slice(marker + ' eval → '.length).trim()
    let value
    try {
      value = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        continue
      }
    }
    if (value && typeof value === 'object') return value
  }
  return null
}

function evaluateCase(testCase, metrics) {
  const checks = []
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

  if (!metrics) {
    add('场景输出', false, '未从 qa-user stdout 解析到 eval JSON')
    return checks
  }
  if (metrics.error) {
    add('场景执行', false, metrics.error)
    return checks
  }

  add('settings 持久化', metrics.ok === true, `ok=${metrics.ok} mode=${metrics.mode}`)
  add('文档横向溢出', metrics.documentOverflow <= 1, `documentOverflow=${metrics.documentOverflow}px (阈值 ≤1)`)
  add('内容区横向溢出', metrics.rootOverflow <= 1, `rootOverflow=${metrics.rootOverflow}px / clientWidth=${metrics.rootClientWidth} (阈值 ≤1)`)
  /*
   * 设置页的顶栏是「设置」标题 + 窗口控制，没有列表工具栏；
   * 对设置页断言"工具栏控件不越界"只会得到"未采集到顶栏控件"的假失败。
   * 设置页已经在上面断言文档/内容区横向溢出，足够覆盖它的宽度问题。
   */
  if (testCase.kind !== 'settings') {
    if (metrics.toolbar) {
      add(
        '工具栏控件不越界',
        metrics.toolbar.pass,
        `controls=${metrics.toolbar.total} overflowing=${(metrics.toolbar.overflowing ?? []).length}` +
          ((metrics.toolbar.overflowing ?? []).length
            ? ` → ${metrics.toolbar.overflowing.map((item) => `${item.label}@${item.left}..${item.right}`).join('; ')}`
            : '')
      )
    } else {
      add('工具栏控件不越界', false, '未采集到顶栏控件')
    }
  }

  if (testCase.kind === 'settings') {
    const alignment = metrics.alignment
    add(
      '设置行左右对齐',
      alignment && alignment.pass,
      alignment
        ? `rows=${alignment.rowCount} groups=${alignment.groups} largest=${alignment.largestGroup} ` +
          `labelSpread=${alignment.labelSpread}px controlSpread=${alignment.controlSpread}px (阈值 ≤2)`
        : '缺少 alignment 数据'
    )
    return checks
  }

  if (testCase.layout === 'list') {
    add('列表行数匹配种子', metrics.rows === SEED_COUNT, `rows=${metrics.rows} expected=${SEED_COUNT}`)
    const badColumns = (metrics.listColumns ?? []).filter((column) => !column.pass)
    const maxDx = Math.max(0, ...(metrics.listColumns ?? []).map((column) => column.dx))
    const maxDw = Math.max(0, ...(metrics.listColumns ?? []).map((column) => column.dw))
    add(
      '表头/行单元格按列对齐',
      badColumns.length === 0,
      `columns=${metrics.columnCount} maxDx=${maxDx}px maxDw=${maxDw}px (阈值 ≤1)` +
        (badColumns.length ? ` bad=${JSON.stringify(badColumns)}` : '')
    )
    add('列表行尺寸有效', (metrics.zeroSizeRows ?? []).length === 0, `zeroSizeRows=${JSON.stringify(metrics.zeroSizeRows ?? [])} zeroSizeCells=${JSON.stringify(metrics.zeroSizeCells ?? [])}`)
  } else {
    add('卡片数量匹配种子', metrics.cardCount === SEED_COUNT, `cards=${metrics.cardCount} expected=${SEED_COUNT}`)
    add(
      '卡片尺寸有效',
      (metrics.zeroSizeCards ?? []).length === 0,
      `zeroSizeCards=${JSON.stringify(metrics.zeroSizeCards ?? [])}`
    )
    const overlap = (metrics.overlaps ?? []).length
    add(
      '卡片两两不重叠',
      overlap === 0,
      `overlaps=${overlap}${overlap ? ` 首对=${JSON.stringify(metrics.overlaps[0])}` : ''} (允许 ≤1px 边缘相交)`
    )
    add(
      '卡片不越出视口',
      (metrics.cardOutOfViewport ?? []).length === 0,
      `outOfViewport=${JSON.stringify(metrics.cardOutOfViewport ?? [])}`
    )
    const requested = Number(testCase.layout.slice('grid-'.length))
    const columns = columnExpectation(requested, metrics.columns, metrics.containerWidth, metrics.viewport?.width ?? 0)
    add('渲染列数', columns.ok, `cols=${metrics.columns}/${requested} container=${metrics.containerWidth}px — ${columns.note}`)
  }
  return checks
}

function runCase(testCase, index) {
  mkdirSync(STEPS_DIR, { recursive: true })
  const steps = makeSteps(testCase)
  const stepsPath = resolve(STEPS_DIR, `${testCase.id}.json`)
  writeFileSync(stepsPath, `${JSON.stringify(steps, null, 2)}\n`, 'utf8')
  /*
    防御性重写：实测偶发"刚写的 steps 文件在下一个用例启动前不见了"（杀软/索引器扫描 .tmp），
    qa-user 于是 ENOENT 退出，看起来像布局失败。启动前确认一次，缺了就再写一遍。
  */
  if (!existsSync(stepsPath)) {
    mkdirSync(STEPS_DIR, { recursive: true })
    writeFileSync(stepsPath, `${JSON.stringify(steps, null, 2)}\n`, 'utf8')
  }

  if (DRY_RUN) {
    // 纯 Node 语法检查：把浏览器表达式当函数体编译，不执行（不需要 Electron）
    try {
      for (const step of steps.steps) {
        if (typeof step.eval === 'string') new Function(`return (${step.eval})`)
      }
    } catch (error) {
      const checks = [{ name: '场景语法', pass: false, detail: String(error.message ?? error) }]
      return { id: testCase.id, kind: testCase.kind, layout: testCase.layout, size: testCase.size, dryRun: true, pass: false, checks }
    }
    console.log(`[dry-run] ${testCase.id}  steps=${stepsPath}  ✓ 语法通过`)
    return { id: testCase.id, kind: testCase.kind, layout: testCase.layout, size: testCase.size, dryRun: true, pass: true, checks: [] }
  }

  if (!existsSync(QA_USER)) {
    throw new Error(`找不到 ${QA_USER}`)
  }
  if (!existsSync(SEED)) {
    throw new Error(`找不到种子数据 ${SEED}`)
  }
  const electron = resolve(ROOT, 'node_modules/electron/dist/electron.exe')
  const built = resolve(ROOT, 'out/main/index.js')
  if (!EXE && !existsSync(electron)) throw new Error(`找不到 Electron: ${electron}（先 npm ci）`)
  if (!EXE && !existsSync(built)) throw new Error(`找不到构建产物: ${built}（先 npm run build）`)

  /*
    每个用例独立 userData：连跑 13 个 Electron 实例时，上一个进程被 taskkill 后
    磁盘句柄/单实例锁不保证立刻释放，共用目录会让 settings.update 偶发卡住
    （表现为 CDP "Runtime.evaluate" 20 秒超时，而不是断言失败）。
    独立目录把这种环境噪声隔离在单个用例内，也让失败可复现。
  */
  const caseUserData = resolve(USER_DATA, testCase.id)

  const runQa = () => {
    const qaArgs = [
      QA_USER,
      '--steps',
      stepsPath,
      '--user-data',
      caseUserData,
      '--seed',
      SEED,
      '--win',
      testCase.size,
      '--timeout',
      String(TIMEOUT)
    ]
    if (BASE_PORT !== null) qaArgs.push('--port', String(Number(BASE_PORT) + index))
    if (EXE) qaArgs.push('--exe', resolve(ROOT, EXE))
    return spawnSync(process.execPath, qaArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT + 30_000,
      env: { ...process.env }
    })
  }

  const started = Date.now()
  let child = runQa()
  /*
    只对"进程/渲染层级"的偶发失败重试一次（CDP 超时、端口/目录竞争），
    断言失败（exit=1 且带具体 FAIL 断言文本）不重试——那是真缺陷，重试只会掩盖。
  */
  const transient = (result) => {
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    return result.status !== 0 && /CDP 超时|等待 CDP 超时|应用进程已退出|ECONNREFUSED/.test(text)
  }
  if (transient(child)) {
    console.log(`  [retry] ${testCase.id} 命中环境噪声，重跑一次`)
    child = runQa()
  }
  const elapsedMs = Date.now() - started
  const stdout = child.stdout ?? ''
  const stderr = child.stderr ?? ''
  const metrics = parseEvalOutput(stdout)
  let checks
  if (child.status !== 0) {
    const all = `${stdout}\n${stderr}`
    const failLine = all.split(/\r?\n/).find((line) => line.includes('FAIL:'))
    // 没有 FAIL: 行时把最后几行带上：空信息会让"到底为什么挂"变成猜谜
    const tail = failLine ? '' : ` — ${all.trim().split(/\r?\n/).slice(-6).join(' | ')}`
    checks = [
      {
        name: 'qa-user 执行',
        pass: false,
        detail: `exit=${child.status}${child.error ? ` error=${child.error.message}` : ''}${failLine ? ` — ${failLine.trim()}` : tail}`
      }
    ]
    if (metrics && metrics.error) checks.push({ name: '场景执行', pass: false, detail: metrics.error })
  } else {
    checks = evaluateCase(testCase, metrics)
  }

  const pass = checks.every((check) => check.pass)
  const shot = resolve(OUT_DIR, `${testCase.id}.png`)
  return {
    id: testCase.id,
    kind: testCase.kind,
    size: testCase.size,
    layout: testCase.layout,
    pass,
    elapsedMs,
    steps: `.tmp/layout/steps/${testCase.id}.json`,
    shot: existsSync(shot) ? `.tmp/layout/${testCase.id}.png` : null,
    checks,
    metrics
  }
}

function formatNumbers(item) {
  const m = item.metrics
  if (!m) return ''
  if (m.error) return `error=${m.error}`
  const parts = [`doc=${m.documentOverflow}px`, `root=${m.rootOverflow}px`]
  if (m.mode === 'list') {
    const maxDx = Math.max(0, ...(m.listColumns ?? []).map((column) => column.dx))
    const maxDw = Math.max(0, ...(m.listColumns ?? []).map((column) => column.dw))
    parts.push(`rows=${m.rows}`, `cols=${m.columnCount}`, `maxDx=${maxDx}px`, `maxDw=${maxDw}px`)
  } else if (m.mode === 'settings') {
    const alignment = m.alignment ?? {}
    parts.push(
      `settingsRows=${alignment.rowCount}`,
      `largestGroup=${alignment.largestGroup}`,
      `labelSpread=${alignment.labelSpread}px`,
      `controlSpread=${alignment.controlSpread}px`
    )
  } else {
    parts.push(`cards=${m.cardCount}`, `cols=${m.columns}/${m.requested}`, `container=${m.containerWidth}px`, `overlaps=${(m.overlaps ?? []).length}`)
  }
  if (m.toolbar) {
    parts.push(`toolbarOverflow=${(m.toolbar.overflowing ?? []).length}/${m.toolbar.total}`)
  }
  return parts.join(' ')
}

/* ------------------------------ 主流程 ------------------------------ */

console.log(`=== verify-layout：matrix=${MATRIX} cases=${CASES.length}${DRY_RUN ? '（dry-run）' : ''} ===`)
if (DRY_RUN) {
  // 生成场景文件时保留上一轮的截图/汇总，不在这里清理证据目录
  mkdirSync(STEPS_DIR, { recursive: true })
} else {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(STEPS_DIR, { recursive: true })
}

/**
 * 用例之间回收残留进程（**默认不做**）。
 *
 * 实测：连续启动 8 个 Electron 后，第 9 个开始偶发"qa-user exit=1"，
 * 但单独跑同一用例又必过——典型的上一轮 renderer/GPU 子进程没退干净，
 * 占着同一个 userData 的 Chromium 单例锁，新实例起来就立刻自杀。
 * qa-user 会按 PID 结束自己的进程树（`/T` 覆盖 renderer/GPU/utility），
 * 因此这里只需要冷却；只有独占 CI 机器上传 `--force-clean` 才按映像名兜底。
 */
function reapLeftovers() {
  if (!FORCE_CLEAN) return
  console.log('[force-clean] 按映像名清理本工程进程（仅限独占机器）')
  spawnSync('taskkill', ['/IM', 'RDPilot.exe', '/F'], { stdio: 'ignore' })
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*RDPilot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ],
    { stdio: 'ignore' }
  )
}

const results = []
for (const [index, testCase] of CASES.entries()) {
  console.log(`\n--- [${index + 1}/${CASES.length}] ${testCase.id} ---`)
  let result
  try {
    result = runCase(testCase, index)
    /*
     * 启动期抖动重试一次（不是断言重试）：
     * 连跑十几个 Electron 场景时，偶发 `qa-user exit=1` 且**没有任何 metric**
     * ——那是 CDP 还没连上就退出了（Windows 上 Chromium 单例锁/GPU 进程回收的延迟），
     * 与"布局不合格"是两回事。只在这条特征上重试一次；
     * 断言失败（有 metrics 的）不重试，避免把真实缺陷藏起来。
     */
    const detail = result.checks?.[0]?.detail ?? ''
    const startupOnly =
      !result.pass &&
      result.checks?.length === 1 &&
      result.checks[0].name === 'qa-user 执行' &&
      // 没有断言输出（驱动层退出）或截图/CDP 超时：都属环境噪声，重试一次
      (!detail.includes('FAIL:') ||
        /CDP 超时|等待 CDP 超时|应用进程已退出|EPERM|EBUSY|EACCES|ENOENT/.test(detail))
    if (startupOnly) {
      console.log('  ↻ 启动期抖动（无断言输出），重试一次')
      reapLeftovers()
      await sleep(1500)
      result = runCase(testCase, index)
    }
  } catch (error) {
    result = {
      id: testCase.id,
      kind: testCase.kind,
      size: testCase.size,
      layout: testCase.layout,
      pass: false,
      checks: [{ name: '驱动', pass: false, detail: String(error.message ?? error) }]
    }
  }
  results.push(result)
  const status = result.pass ? 'PASS' : 'FAIL'
  console.log(`${status}  ${result.id}  ${formatNumbers(result)}`)
  for (const check of result.checks) {
    console.log(`  ${check.pass ? 'ok  ' : 'FAIL'} ${check.name} — ${check.detail}`)
  }
  // 见 reapLeftovers 注释：默认只冷却（qa-user 已按 PID 清干净），--force-clean 才兜底
  reapLeftovers()
  await sleep(700)
}

const failed = results.filter((item) => !item.pass)
const summary = {
  generatedAt: new Date().toISOString(),
  matrix: MATRIX,
  dryRun: DRY_RUN,
  seed: 'tests/ui/fixtures/seed-data.json',
  viewportProfile: 'Emulation.setDeviceMetricsOverride (qa-user --win)',
  cases: results
}
writeFileSync(resolve(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log(`\n=== summary：${results.length - failed.length}/${results.length} PASS ===`)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${formatNumbers(result)}`)
}
console.log(`\n证据：${resolve(OUT_DIR, 'summary.json')}`)
if (!DRY_RUN) console.log(`截图：${OUT_DIR}/*.png`)
if (failed.length > 0) {
  console.error(`\n${failed.length} 个用例失败`)
  process.exit(1)
}
process.exit(0)
