import { logger } from '../utils/logger'
import { getStore } from '../services/store'
import { runExe, systemExe } from './exec'

/**
 * cmdkey 免密（唯一目的是把密码交给 Windows 凭据管理器，mstsc 自己会去取）。
 *
 * ⚠️ 必须数组传参：`/pass:` 里可能含空格与特殊字符，走 shell 会被拆词；
 * 且 Git Bash 会把 `/generic:` 这类参数当路径做转换（实测 `/list` → `C:/Program Files/Git/list`）。
 */
const CMDKEY = systemExe('cmdkey.exe')

/**
 * 凭据**类型**同样是不确定维度（ADR D-20）：
 *  - `/add:`      → 「域密码」(Domain Password)，mstsc 自己勾"记住我"时用这种
 *  - `/generic:`  → 「普通」(Generic)，社区成功案例多用这种
 * 两者都能 exit 0，而 mstsc 到底读哪种官方没有说明 —— 写错就是"代码全绿、日志全对、用户照样被弹框"。
 * 因此两种都写；实测同 TargetName 下两种类型**可并存、互不覆盖**。
 */
const TYPE_FLAGS = ['/add:', '/generic:'] as const

/**
 * 目标名同样不确定：mstsc 查凭据的 TargetName 是否带端口，官方没写。
 * 因此**无条件双写**（不再对 3389 特判）——多一条毫秒级调用 + 一条凭据条目，
 * 买断"这台机器免密、那台不免密"的随机性。
 */
function targetsFor(host: string, port: number): string[] {
  return Array.from(new Set([`TERMSRV/${host}`, `TERMSRV/${host}:${port}`]))
}

/** 兼容中英文两种本地化输出，注意中文冒号 U+FF1A */
const TARGET_LABEL_RE = /^(?:目标|Target)\s*[:：]\s*(.+)$/i

/**
 * 判断 `/list:<target>` 的输出里是否**真的还有这条凭据**。三个坑：
 *  1) cmdkey 输出是本地化的（中文是「目标:」不是 `Target:`）→ 不能只匹配英文标签；
 *  2) `/list:<target>` 是前缀匹配，查 `TERMSRV/host` 也会列出 `TERMSRV/host:3389`
 *     → 必须整行值精确相等，不能用 includes/前缀；
 *  3) 未知语言下标签行可能解析不出来 → 用行尾匹配兜底，避免"恒为 0"导致谎报已清除。
 */
export function hasExactTarget(listOutput: string, target: string): boolean {
  const wanted = target.trim().toLowerCase()
  const lines = listOutput
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const labeled = lines
    .map((line) => TARGET_LABEL_RE.exec(line)?.[1]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))

  if (labeled.length > 0) return labeled.includes(wanted)
  return lines.some((line) => line.toLowerCase().endsWith(wanted))
}

export interface AddCredentialResult {
  /** 至少有一条写入成功即为 true（部分失败只记 warning，不让用户误以为完全没存上） */
  ok: boolean
  /** 面向用户的非致命提示 */
  warnings: string[]
}

/** 兜底写入的系统凭据保留多久后自动清理（毫秒） */
const TEMP_CREDENTIAL_TTL_MS = 120_000
/** 目标凭据仍在使用时推迟清理的次数上限（每次推迟一个 TTL，覆盖长时间会话） */
const MAX_CLEANUP_DEFER = 120

/** 等待清理的定时器集合：unref 后不阻止进程退出 */
const cleanupTimers = new Set<ReturnType<typeof setTimeout>>()

/**
 * 写入后立刻抓一份 `/list:<target>` 的归一化输出，作为"这条凭据是不是还是我们写的那条"的指纹。
 * 为什么需要：`TERMSRV/<host>` 与用户在 mstsc 里勾"记住我的凭据"是**同一个** TargetName，
 * 系统层面无法区分归属；清理时若无条件 `/delete`，会把用户刚存下的凭据一并删掉（P2-10）。
 * 指纹变化（类型集合 / 用户名 / 条目数不同）就说明这条凭据已被别的程序改写过 → 放弃清理。
 */
type TargetFingerprints = Map<string, string>

function normalizeListing(text: string): string {
  return text
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0)
    .join('\n')
}

async function listTarget(target: string): Promise<string | null> {
  const res = await runExe(CMDKEY, ['/list:' + target], 5000)
  if (res.spawnError) return null
  return normalizeListing(res.stdout)
}

async function captureFingerprints(targets: readonly string[]): Promise<TargetFingerprints> {
  const map: TargetFingerprints = new Map()
  for (const target of targets) {
    const listing = await listTarget(target)
    if (listing !== null) map.set(target, listing)
  }
  return map
}

/**
 * 兜底通道开关（R5 #080 / R6 #108）：
 * 默认 **关闭**。`cmdkey /pass:` 会把明文拼进命令行，任务管理器/WMI 可见，
 * 只有用户在设置里显式勾选 `allowCmdkeyFallback` 才允许写系统凭据。
 * 读取失败（极早期启动、store 未就绪）一律按关闭处理——安全默认不靠运气。
 */
function fallbackAllowed(): boolean {
  try {
    // 直接读 store 而不是 settingsService：后者会拖入 nativeTheme，
    // 让 verify-cmdkey.mjs 的最小 Electron 桩链接失败（少一个无关依赖）。
    return getStore().get().settings.allowCmdkeyFallback === true
  } catch {
    return false
  }
}

/**
 * 临时凭据清理：写入成功 2 分钟后尝试 `cmdkey /delete`。
 * 只删除本次兜底写入的 target（host × port 两种写法），不批量扫描/删除其它系统凭据。
 *
 * 三道闸（P2-10：用户刚在 mstsc 里勾"记住我"时不能把人家刚存的凭据删掉）：
 *  1. **目标仍在使用**（由 mstscService 注入 `isTargetInUse`）→ 推迟一个 TTL 再试；
 *  2. **指纹变了**（类型集合/用户名/条目数被 mstsc 等其它程序改写过）→ 放弃清理；
 *  3. 目标已经不在了 → 视为已清理，不必再 `/delete`。
 * 只有三条都通过才删——即"这条凭据仍然是我们 2 分钟前写的那一条"。
 * 进程若在 2 分钟内退出，残留需用户到 Windows 凭据管理器手动清理（见文档限制）。
 */
function scheduleTempCleanup(
  host: string,
  port: number,
  fingerprints: TargetFingerprints,
  isTargetInUse?: () => boolean
): void {
  const arm = (deferCount: number): void => {
    const timer = setTimeout(() => {
      cleanupTimers.delete(timer)
      void cleanupTempCredential(host, port, fingerprints, isTargetInUse).then((outcome) => {
        if (outcome === 'deferred' && deferCount < MAX_CLEANUP_DEFER) {
          arm(deferCount + 1)
          return
        }
        if (outcome === 'deferred') {
          logger.warn(
            'credential',
            `cmdkey 临时凭据因目标仍在使用而放弃清理 ${host}:${port}（请到 Windows 凭据管理器手动清理）`
          )
        }
      })
    }, TEMP_CREDENTIAL_TTL_MS)
    timer.unref?.()
    cleanupTimers.add(timer)
  }
  arm(0)
}

type CleanupOutcome = 'cleared' | 'kept' | 'deferred' | 'failed'

/** 按指纹判定"还属于本次写入"的 target 才删；返回结果只用于日志与推迟策略 */
async function cleanupTempCredential(
  host: string,
  port: number,
  fingerprints: TargetFingerprints,
  isTargetInUse?: () => boolean
): Promise<CleanupOutcome> {
  let inUse = false
  try {
    inUse = isTargetInUse?.() === true
  } catch {
    // 判定函数本身出错时按"在用"处理：宁可留一条凭据，也不误删用户的
    inUse = true
  }
  if (inUse) return 'deferred'

  const removable: string[] = []
  for (const target of targetsFor(host, port)) {
    const expected = fingerprints.get(target)
    const current = await listTarget(target)
    if (current === null) return 'failed'
    if (!hasExactTarget(current, target)) continue // 已经不在了，无需删除
    if (expected === undefined) {
      // 写入后没抓到指纹（cmdkey 当时不可用）：无法证明归属，保守跳过
      logger.warn('credential', `cmdkey 临时凭据缺少写入指纹，跳过清理 ${target}`)
      return 'kept'
    }
    if (current !== expected) {
      logger.info('credential', `cmdkey 临时凭据已被其它程序改写，跳过清理 ${target}`)
      return 'kept'
    }
    removable.push(target)
  }
  if (removable.length === 0) {
    logger.info('credential', `cmdkey 临时凭据已不存在 ${host}:${port}`)
    return 'cleared'
  }

  const result = await deleteTargets(removable)
  if (!result.ok) {
    logger.warn(
      'credential',
      `cmdkey 临时凭据清理未完成（remaining=${result.remaining.join(',')}）`
    )
    return 'failed'
  }
  logger.info('credential', `cmdkey 临时凭据已清理 ${host}:${port}`)
  return 'cleared'
}

export interface AddCredentialOptions {
  /**
   * 覆盖设置里的 allowCmdkeyFallback（仅供主进程内部/验证脚本显式放行）。
   * 不传时读当前 data.json 的 settings.allowCmdkeyFallback，默认 false。
   */
  allowFallback?: boolean
  /**
   * 目标（host:port）此刻是否仍被会话占用。由 mstscService 注入（避免 cmdkey ←→ mstscService
   * 循环依赖）。返回 true 时推迟临时凭据清理：会话还开着，用户很可能刚在登录框勾了"记住我"，
   * 此时 Windows 正在使用/改写这条凭据（P2-10）。
   */
  isTargetInUse?: () => boolean
}

/**
 * 写入免密凭据：目标名 × 类型全组合（最多 4 条，总耗时 <150ms 量级）。
 * 不要"优化"成只写一种 —— 那会把不确定性留给用户。
 */
export async function addCredential(
  host: string,
  port: number,
  username: string | null,
  domain: string | null,
  password: string,
  options: AddCredentialOptions = {}
): Promise<AddCredentialResult> {
  const allowed = options.allowFallback ?? fallbackAllowed()
  if (!allowed) {
    /*
     * 直接返回失败、**不启动 cmdkey**：上层（mstscService）看到 ok=false
     * 会把本次连接按"无密码"继续（弹系统登录框让用户手输），
     * 明文不会出现在任何子进程命令行里。
     */
    logger.info('credential', 'cmdkey 兜底已禁用（allowCmdkeyFallback=false），跳过系统凭据写入')
    return { ok: false, warnings: ['系统凭据兜底已在设置中禁用'] }
  }

  const user = domain ? `${domain}\\${username ?? ''}` : (username ?? '')
  const targets = targetsFor(host, port)
  const total = targets.length * TYPE_FLAGS.length
  const warnings: string[] = []
  let success = 0

  for (const target of targets) {
    for (const flag of TYPE_FLAGS) {
      const args = [flag + target, '/user:' + user, '/pass:' + password]
      const res = await runExe(CMDKEY, args, 5000)
      const kind = flag.slice(1, -1)
      // 只记录 target 与退出码，绝不记录完整命令行（logger 另有 /pass: 脱敏兜底）
      logger.info('credential', `cmdkey ${kind} ${target} exit=${res.code}`)
      if (res.code === 0 && !res.spawnError) {
        success += 1
      } else {
        warnings.push(`${kind} ${target} 写入失败(${res.spawnError ?? res.code})`)
      }
    }
  }

  if (success === 0) {
    // 第一次全失败：等 150ms 再整轮重试一次（凭据服务偶发忙/瞬态失败很常见）
    await new Promise((resolve) => setTimeout(resolve, 150))
    for (const target of targets) {
      for (const flag of TYPE_FLAGS) {
        const res = await runExe(CMDKEY, [flag + target, '/user:' + user, '/pass:' + password], 5000)
        if (res.code === 0 && !res.spawnError) success += 1
      }
    }
    if (success > 0) {
      logger.info('credential', `cmdkey 第二轮写入成功 ${success} 条`)
      // 写进了系统凭据管理器就必须负责清理，避免明文凭据长期残留；
      // 清理前先记指纹，否则 2 分钟后无法判断这条凭据是否还是我们写的那一条（P2-10）
      const fingerprints = await captureFingerprints(targets)
      scheduleTempCleanup(host, port, fingerprints, options.isTargetInUse)
      return { ok: true, warnings: [`首次写入失败，重试后成功 ${success} 条`] }
    }
    return { ok: false, warnings: warnings.length > 0 ? warnings : ['全部写入失败'] }
  }
  if (success < total) {
    warnings.push(`部分组合写入失败（${success}/${total}），可能仍需手动输入密码`)
  }
  const fingerprints = await captureFingerprints(targets)
  scheduleTempCleanup(host, port, fingerprints, options.isTargetInUse)
  return { ok: true, warnings }
}

export interface DeleteCredentialResult {
  ok: boolean
  /** 删完仍存在的目标名（非空即表示没清干净，上层不得谎报成功） */
  remaining: string[]
}

/**
 * 删除系统凭据 + **删后校验**（ADR D-20）。
 * "清除密码"是用户判断工具是否安全的关键动作，谎报一次就失去信任。
 * 实测：一次 `/delete:<target>` 会清空该 target 下的全部类型（普通 + 域密码），
 * 因此不需要按类型分别删；重试上限 2（1 次删除 + 1 次兜底）。
 *
 * ⚠️ 调用边界（R5 #080 / R6 #108）：
 *  - 用户数据清理路径（删连接、清空全部、清密码）**绝不调用**本函数——
 *    `TERMSRV/<host>` 与用户自己在 mstsc 里勾「记住我的凭据」是同一个 target，
 *    系统层面无法区分归属，批量删除会误伤用户自己的系统凭据；
 *  - 唯一调用点是 `scheduleTempCleanup`：仅在用户显式开启 `allowCmdkeyFallback`
 *    且本次确实写入成功后，延迟 2 分钟清理本次写入、且指纹仍与写入时一致的 target
 *    （见 `cleanupTempCredential`，P2-10）。
 * 若将来要提供"清理这台主机的系统凭据"手动入口，必须由用户逐条确认，绝不可批量静默调用。
 */
export async function deleteCredential(
  host: string,
  port: number
): Promise<DeleteCredentialResult> {
  return deleteTargets(targetsFor(host, port))
}

/**
 * 逐个删除给定 target（已由调用方筛过"确实属于本次写入"），并做删后校验。
 * 与 `deleteCredential` 分开是因为临时清理路径只删指纹匹配的子集（P2-10）。
 */
async function deleteTargets(targets: readonly string[]): Promise<DeleteCredentialResult> {
  const remaining: string[] = []

  for (const target of targets) {
    let cleared = false
    for (let attempt = 0; attempt < 2 && !cleared; attempt += 1) {
      const del = await runExe(CMDKEY, ['/delete:' + target], 5000)
      const list = await runExe(CMDKEY, ['/list:' + target], 5000)
      logger.info(
        'credential',
        `cmdkey delete ${target} attempt=${attempt + 1} exit=${del.code} cleared=${!hasExactTarget(list.stdout, target)}`
      )
      // 是否删干净只看 /list 复核结果（退出码 + 文本都不可信：输出会被本地化）
      cleared = !hasExactTarget(list.stdout, target)
      if (!cleared) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (!cleared) remaining.push(target)
  }

  return { ok: remaining.length === 0, remaining }
}

/**
 * 测试钩子：让 `scripts/verify-cmdkey.mjs` 不必等 2 分钟的 TTL 就能验证
 * "在用则推迟 / 指纹变了则放弃 / 指纹一致才删"这三道闸（P2-10）。生产代码不调用。
 */
export const __testHooks = {
  captureFingerprints,
  cleanupTempCredential,
  /** 把某些 target 的指纹改成"被别的程序写过"的样子，用于构造"用户刚勾记住我"的场景 */
  bumpFingerprint(fingerprints: TargetFingerprints, target: string): void {
    const current = fingerprints.get(target) ?? ''
    fingerprints.set(target, `${current}\n用户: someone-else`)
  }
}
