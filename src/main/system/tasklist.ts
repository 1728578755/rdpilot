import { runExe, systemExe } from './exec'

const TASKLIST = systemExe('tasklist.exe')

/**
 * 进程探测结果。三个维度缺一不可：
 *  - `probed`：tasklist 本身是否跑通（被 EDR 拦掉时为 false，此时后两个字段无意义）
 *  - `alive`：该 PID **且该映像名**是否存在
 *  - `title`：窗口标题；进程存在但读不到标题时为 null（**与"标题不含主机名"是两件事**）
 */
export interface ProcInfo {
  probed: boolean
  alive: boolean
  title: string | null
}

/** 一行进程信息（只保留我们判断身份要用的三列） */
export interface ProcRow {
  pid: number
  /** 映像名（含 .exe，原始大小写） */
  image: string
  /** 窗口标题；无主窗口的服务类进程为 null */
  title: string | null
}

/**
 * 一次全量 tasklist 的结果快照。
 *
 * 为什么要快照而不是每会话一次查询：旧实现对每条会话每 1.5–5s 各 spawn 一次
 * `tasklist /FI "PID eq N"`，20 条会话就是每分钟上千次进程创建——EDR 会当成进程
 * 创建风暴。改成"一拍一次全量 + 本地 diff"后，进程创建数与会话数无关。
 */
export interface ProcSnapshot {
  /** tasklist 是否跑通；false 时 rows 无意义（调用方必须保持"不知道"） */
  probed: boolean
  rows: Map<number, ProcRow>
  /** 采样时刻（ms） */
  takenAt: number
}

/**
 * 解析一行 CSV（tasklist /FO CSV 的字段里可能带逗号，如内存列 `"45,678 K"`，
 * 还有 `""` 转义，所以不能用 split(',')）。
 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells
}

/** 映像名比较：`MSTSC.EXE` 与 `mstsc.exe` 是同一个进程 */
export function sameImage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * 一次全量枚举进程（`tasklist /V /FO CSV /NH`，不加 /FI）。
 *
 * 语言无关性：存在性只看 `"<映像>","<pid>"` 两列（列序固定），标题按固定列索引 8 取，
 * 表头本地化不影响解析；表头行带 `"映像名称","PID"` 之类，行首不是纯数字行首
 * （列 1 不是数字）会被自然跳过。
 *
 * @param image 只要该映像名的行（大小写无关）。省略 = 全量。
 */
export async function listProcesses(image?: string): Promise<ProcSnapshot> {
  const rows = new Map<number, ProcRow>()
  const res = await runExe(TASKLIST, ['/V', '/FO', 'CSV', '/NH'], 8000, 'gbk')
  const takenAt = Date.now()
  if (res.spawnError || res.timedOut || res.code !== 0) {
    return { probed: false, rows, takenAt }
  }

  const lines = res.stdout
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || !line.startsWith('"')) continue
    const cols = splitCsvLine(line)
    if (cols.length < 2) continue
    const name = cols[0].trim()
    const pid = Number(cols[1].trim())
    if (!name || !Number.isInteger(pid) || pid <= 0) continue
    if (image && !sameImage(name, image)) continue
    // 列序：映像名称 | PID | 会话名 | 会话# | 内存使用 | 状态 | 用户名 | CPU 时间 | 窗口标题
    const rawTitle = cols.length >= 9 ? cols[8].trim() : ''
    rows.set(pid, { pid, image: name, title: rawTitle.length > 0 ? rawTitle : null })
  }
  return { probed: true, rows, takenAt }
}

/**
 * 在快照里判断某 PID 是否仍是"我们要的那个进程"。
 *
 * PID 会被复用：只看 `"<任意映像>","<pid>"` 时，会话早已退出、PID 被
 * 别的程序拿走，存活检查会永远为真（卡片永远停在"已连接"）。
 * 因此必须同时校验映像名；传了 image 却不匹配 = 我们的进程已经没了。
 */
export function findInSnapshot(snapshot: ProcSnapshot, pid: number, image?: string): ProcInfo {
  if (!snapshot.probed) return { probed: false, alive: false, title: null }
  const row = snapshot.rows.get(pid)
  if (!row) return { probed: true, alive: false, title: null }
  if (image && !sameImage(row.image, image)) return { probed: true, alive: false, title: null }
  return { probed: true, alive: true, title: row.title }
}

/**
 * 读取指定 PID 的存活状态与窗口标题（单点查询，非热路径）。
 *
 * 热路径（会话状态机）请用 `listProcesses()` 的快照 + `findInSnapshot`：
 * 每会话一次 spawn 在会话数多时就是进程创建风暴。
 *
 * 为什么必须读标题：实测 `mstsc /v:127.0.0.1:1`（必然失败）时进程在 1.5/3/5/8s
 * 四个时刻**全部存活**、标题恒为「远程桌面连接」——只做存活校验会稳定误判成"已连接"。
 */
export async function queryProcess(pid: number, image?: string): Promise<ProcInfo> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { probed: true, alive: false, title: null }
  }
  const snapshot = await listProcesses(image)
  return findInSnapshot(snapshot, pid, image)
}

/** 终止确认的最长等待（ms）：taskkill 返回成功不代表进程已经消失 */
const TERMINATE_WAIT_MS = 3000
/** 终止确认的采样间隔（ms） */
const TERMINATE_POLL_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * 结束进程（先礼后兵），并**等进程真的消失**再返回。
 *
 * 旧实现只看 taskkill 的退出码：`/T` 投递 WM_CLOSE 后进程可能还要几秒才退出，
 * 调用方（断开 / 重连）立刻返回"已断开"，紧接着新一轮 connect 又拉起一个窗口，
 * 于是同一连接出现两个窗口、旧窗口成孤儿；更糟的是 PID 被复用后
 * `child.kill()` 会打到别人的进程上。
 *
 * 这里在 taskkill 成功后轮询快照确认：PID 消失、或该 PID 已被**别的映像**占用
 * （= 我们的进程确实没了），才算成功。
 */
export async function terminateProcess(
  pid: number,
  force: boolean,
  image?: string
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
  const res = await runExe(systemExe('taskkill.exe'), args, 5000)
  if (res.spawnError || res.code !== 0) return false

  const deadline = Date.now() + TERMINATE_WAIT_MS
  for (;;) {
    const info = await queryProcess(pid, image)
    // tasklist 探测不了时无法确认，按"未确认退出"处理，让调用方决定是否升级强杀
    if (!info.probed) return false
    if (!info.alive) return true
    if (Date.now() >= deadline) return false
    await delay(TERMINATE_POLL_MS)
  }
}
