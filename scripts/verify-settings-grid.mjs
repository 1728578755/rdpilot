#!/usr/bin/env node
/**
 * 设置页几何断言（R26）：启动真实窗口，量出每一行/每个控件的盒模型，输出违例清单。
 *
 * 为什么需要它：截图只能证明"这次看着还行"，说不出"控件中心差 18px""这一格
 * 右边空了 437px"。本脚本把 UI-DESIGN-STANDARD 第 5 节的几何契约变成断言：
 *
 *   label-slot-center  标签与控件同一中线（控件换行到第二行时豁免）
 *   band-center        同一横带的控件中线一致（只读值/多行块不参与）
 *   band-height        同一横带的行等高
 *   right-blank        横带右缘到达卡片右缘（右侧不留空白）
 *   overflow-x         行内无横向溢出
 *   label-clip/hint-clip  标签/说明没有被裁
 *   slot-clip          控件槽不越出本行
 *   select-vcenter     下拉可见值垂直居中（≤1px）
 *   select-hcenter     下拉可见值居中于「左边缘 → 箭头左缘」（≤1.5px）
 *   select-wide        控件不比文字宽太多（文字 + chrome + 同档容差）
 *
 * 用法：
 *   node scripts/verify-settings-grid.mjs --width 1440 --height 950
 *   node scripts/verify-settings-grid.mjs --width 900 --height 950 --font 1.5
 *   node scripts/verify-settings-grid.mjs --exe release/win-unpacked/RDPilot.exe --width 1440
 *
 * 退出码：有违例 = 1，无违例 = 0（可直接进 CI）。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const argOf = (n, d = null) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const width = Number(argOf('width', '1200'))
const height = Number(argOf('height', '900'))
const outFile = resolve(argOf('out', `.tmp/grid/settings-grid-${width}.json`))
mkdirSync(resolve(outFile, '..'), { recursive: true })

const PORT = await new Promise((ok) => {
  const s = net.createServer()
  s.unref()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => ok(port))
  })
})
const USER_DATA = resolve(`.tmp/qa-cdp/verify-${process.pid}`)
mkdirSync(USER_DATA, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const exeArg = argOf('exe', null)
const child = exeArg
  ? spawn(resolve(exeArg), [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
      stdio: 'ignore',
      env
    })
  : spawn(
      resolve('node_modules/electron/dist/electron.exe'),
      [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '.'],
      { stdio: 'ignore', env }
    )
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitTarget() {
  for (let i = 0; i < 160; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('no target')
}
const target = await waitTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { ok, fail } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? fail(new Error(m.error.message)) : ok(m.result)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
const send = (method, params = {}) =>
  new Promise((ok, fail) => {
    const id = ++seq
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        fail(new Error('timeout ' + method))
      }
    }, 60000)
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
await send('Runtime.enable')
await send('Page.enable')
await sleep(1600)
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
await sleep(500)

const fontArgValue = argOf('font', '1')
if (fontArgValue !== '1') {
  const prefs = JSON.stringify({
    fontScale: Math.round(Number(fontArgValue) * 100),
    highContrast: false,
    underlineLinks: false,
    reduceMotion: 'system',
    focusRingBold: false,
    liveAnnouncements: true
  })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('rdpilot.a11y.prefs.v1', ${JSON.stringify(prefs)}) } catch (e) {}`
  })
  await send('Page.reload', { ignoreCache: false })
  await sleep(2600)
}

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  for (const b of document.querySelectorAll('button')) {
    const txt = (b.textContent || '').trim();
    if (txt === '稍后' || txt === '知道了' || txt === '跳过') { click(b); break; }
  }
  await sleep(300);
  const x = document.querySelector('[role="dialog"] button[aria-label="关闭"], [role="dialog"] button[aria-label="Close"]');
  if (x) click(x);
  await sleep(300);
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '设置' || (b.textContent || '').trim() === '设置');
  click(btn);
  // 等异步块（备份状态/完整性报告）挂载完，否则会把"块还没来"的中间态当成半格空白
  await sleep(5200);
  const issues = [];
  const dump = [];
  const R = (el) => el.getBoundingClientRect();
  const labelOf = (row) => (row.querySelector('[data-setting-label="true"]')?.textContent || '').trim().slice(0, 18);
  const add = (kind, section, label, detail) => issues.push({ kind, section, label, detail });
  let rows = 0, selects = 0, bands = 0;

  for (const sec of document.querySelectorAll('section[id^="settings-"]')) {
    const body = sec.querySelector('[data-settings-body="true"]');
    if (!body) continue;
    const cols = Number(body.dataset.cols || 1);
    const bodyR = R(body);
    const rowEls = [...body.querySelectorAll('[data-setting-row="true"]')].filter((r) => R(r).width > 0);
    rows += rowEls.length;

    // 横带：按 top 分组（±2px）
    const bandMap = new Map();
    for (const row of rowEls) {
      const top = Math.round(R(row).top);
      let key = [...bandMap.keys()].find((k) => Math.abs(k - top) <= 2);
      if (key === undefined) { key = top; bandMap.set(key, []); }
      bandMap.get(key).push(row);
    }
    bands += bandMap.size;

    for (const [top, band] of bandMap) {
      const sorted = band.slice().sort((a, b) => R(a).left - R(b).left);
      const last = sorted[sorted.length - 1];
      const rightGap = bodyR.right - R(last).right;
      if (rightGap > 3) {
        add('right-blank', sec.id, labelOf(last), 'band ends ' + Math.round(rightGap) + 'px before body right');
      }
      // 同带等高
      const hs = band.map((r) => Math.round(R(r).height));
      if (Math.max(...hs) - Math.min(...hs) > 1) {
        add('band-height', sec.id, labelOf(band[0]), 'heights ' + hs.join('/'));
      }
      // 同带控件中心线（只比"在详情行"的控件；无说明的行控件在标题行，不参与）
      const bodyControls = (row) => {
        // bodyAlign='start' 的复合组（上下两个下拉）按组顶对齐，不参与中线比较
        if (row.querySelector('.rp-setting-body[data-body-align="start"]')) return null;
        const slot = row.querySelector('.rp-setting-body [data-setting-slot="true"]');
        if (!slot) return null;
        return slot.querySelector('select, input, textarea, button, [role="switch"]') || slot;
      };
      const centers = band.map((r) => {
        const c = bodyControls(r);
        if (!c) return null; // 只读值/多行文本框/无说明行不参与"控件中线"比较
        return Math.round(R(c).top + R(c).height / 2);
      }).filter((v) => v !== null);
      if (centers.length > 1 && Math.max(...centers) - Math.min(...centers) > 1) {
        add('band-center', sec.id, labelOf(band[0]), 'slot centers ' + centers.join('/'));
      }
    }

    for (const row of rowEls) {
      const label = row.querySelector('[data-setting-label="true"]');
      const dbgSlot = row.querySelector('[data-setting-slot="true"]');
      dump.push({
        s: sec.id,
        l: labelOf(row),
        top: Math.round(R(row).top),
        h: Math.round(R(row).height),
        head: row.firstElementChild ? Math.round(R(row.firstElementChild).height) : 0,
        labelTop: label ? Math.round(R(label).top) : null,
        labelH: label ? Math.round(R(label).height) : null,
        slotTop: dbgSlot ? Math.round(R(dbgSlot).top) : null,
        slotH: dbgSlot ? Math.round(R(dbgSlot).height) : null,
        gc: getComputedStyle(row).gridColumn,
        w: Math.round(R(row).width),
        x: Math.round(R(row).left)
      });
      const slot = row.querySelector('[data-setting-slot="true"]');
      const hint = row.querySelector('[data-setting-hint="true"]');
      const name = labelOf(row);
      if (row.scrollWidth - row.clientWidth > 1) add('overflow-x', sec.id, name, 'row ' + (row.scrollWidth - row.clientWidth) + 'px');
      if (label && label.scrollWidth - label.clientWidth > 1 && !label.textContent.includes('\\n')) {
        add('label-clip', sec.id, name, label.scrollWidth + '>' + label.clientWidth);
      }
      if (hint && hint.scrollWidth - hint.clientWidth > 1) add('hint-clip', sec.id, name, hint.scrollWidth + '>' + hint.clientWidth);
      /*
       * R29：控件中线锚在**说明第一行**的中线（不是整块说明）。
       * 无说明的行控件留在标题行，退回「控件中线 = 标签中线」。
       */
      if (label && slot) {
        const control = slot.querySelector('select, input, textarea, button, [role="switch"]') || slot;
        const cc = R(control).top + R(control).height / 2;
        const startAligned = row.querySelector('.rp-setting-body[data-body-align="start"]');
        if (hint && !startAligned) {
          /* R30：控件与说明整块同中线（align-items:center），不再只对第一行 */
          const hc = R(hint).top + R(hint).height / 2;
          if (Math.abs(cc - hc) > 1.5) {
            add('vertical', sec.id, name, 'hint delta ' + Math.round((cc - hc) * 10) / 10);
          }
        } else if (!hint) {
          const lc = R(label).top + R(label).height / 2;
          if (Math.abs(cc - lc) > 1.5) add('vertical', sec.id, name, 'label delta ' + Math.round((cc - lc) * 10) / 10);
        }
      }
      if (slot) {
        const sr = R(slot);
        if (sr.right > R(row).right - 8) add('slot-clip', sec.id, name, 'slot right ' + Math.round(sr.right - R(row).right));
        const sel = slot.querySelector('select');
        if (sel) {
          selects++;
          const value = slot.querySelector('.rp-select-value');
          const text = slot.querySelector('.rp-select-value-text');
          if (value) {
            const vr = R(value), tr = text ? R(text) : vr;
            const box = R(sel.parentElement);
            const vDelta = Math.abs((vr.top + vr.height / 2) - (box.top + box.height / 2));
            if (vDelta > 1) add('select-vcenter', sec.id, name, 'delta ' + Math.round(vDelta * 10) / 10);
            // 居中基准：左边缘到箭头左缘
            const chev = slot.querySelector('.rp-select-chevron');
            const arrowLeft = chev ? R(chev).left : box.right - 14;
            const want = (box.left + arrowLeft) / 2;
            const got = tr.left + tr.width / 2;
            if (Math.abs(got - want) > 1.5) add('select-hcenter', sec.id, name, 'delta ' + Math.round((got - want) * 10) / 10);
            // 控件明显宽于文字：文字宽 + chrome 之外不应超过 24px
            const textW = tr.width;
            const fs = Number(getComputedStyle(slot).getPropertyValue('--fs')) || 1;
            // 允许同档统一（≤1.5rem）与呼吸空间
            const expected = textW + 36 * fs + 24 * fs + 24 * fs;
            if (box.width > expected + 4) add('select-wide', sec.id, name, 'box ' + Math.round(box.width) + ' text ' + Math.round(textW));
          }
        }
      }
    }
  }
  return JSON.stringify({ viewport: { w: innerWidth, h: innerHeight }, totals: { rows, selects, bands }, issues, dump });
})()`)

const data = typeof result === 'string' ? JSON.parse(result) : result
writeFileSync(outFile, JSON.stringify(data, null, 2))
const byKind = {}
for (const i of data.issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1
console.log(`viewport ${width}x${height} rows=${data.totals.rows} selects=${data.totals.selects} bands=${data.totals.bands}`)
console.log('issues:', Object.keys(byKind).length ? JSON.stringify(byKind) : 'none')
for (const i of data.issues.slice(0, 40)) console.log(` - [${i.kind}] ${i.section} · ${i.label} · ${i.detail}`)

ws.close()
child.kill()
await sleep(500)
try {
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
} catch {}
process.exit(data.issues.length > 0 ? 1 : 0)
