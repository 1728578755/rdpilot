import { useCallback, useEffect, useRef, useState } from 'react'

import { useConnStateEvents } from './hooks/useConnState'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTheme } from './hooks/useTheme'
import { useConnectionStore } from './store/useConnectionStore'
import { useGroupStore } from './store/useGroupStore'
import { useProbeStore } from './store/useProbeStore'
import { useSettingsStore } from './store/useSettingsStore'
import { useUiStore } from './store/useUiStore'
import { AppShell } from './components/layout/AppShell'
import { Button } from './components/common/Button'
import { ConfirmDialog } from './components/common/ConfirmDialog'
import { ToastHost } from './components/common/ToastHost'
import { HostListView } from './components/views/HostListView'
import { SettingsView } from './components/views/SettingsView'
import { ConnectionDrawer } from './components/connection/ConnectionDrawer'
import { confirmProdConnect } from './components/connection/ConnectionCard'
import { confirmUnreachable } from './components/connection/drawer/confirmUnreachable'
import { HelpDialog } from './components/help/HelpDialog'
import { Onboarding } from './components/help/Onboarding'
import { markWelcomeShown, shouldShowWelcome, WelcomeDialog } from './components/help/WelcomeDialog'
import { CommandPalette } from './components/palette/CommandPalette'
import { HealthAlertHost } from './components/monitor/HealthAlertHost'
import { CredentialLockOverlay } from './components/credential/CredentialLockOverlay'
import { DataHealthBanner, useDataHealth } from './components/data/DataHealthBanner'
import { useHelpStore } from './components/help/useHelpStore'
import { ImportWizard } from './components/modals/ImportWizard'
import { t, useLocale } from './i18n'
import { errorText } from './i18n/errors'
import { overlayIsActive } from './utils/overlayStack'

/**
 * 首屏耗时基线：模块加载即开始计时（早于 App 挂载），bootstrap 完成时
 * 打一次 performance mark/measure 并输出唯一一条 [perf] 日志。
 * 重试/严格模式二次挂载都不会重复刷屏（bootPerfReported 只放行一次）。
 */
const BOOT_PERF_START = performance.now()
const BOOT_PERF_NAME = 'rdpilot:bootstrap'
let bootPerfReported = false

/**
 * bootstrap 超时：主进程若在初始化时卡住（注册表探测、杀软锁文件），
 * IPC 永远不 resolve，界面就永久停在「正在启动」，用户只能杀进程——而且没有重试入口。
 * 15 秒是"明显不正常但又不冤枉慢机器"的取值：正常冷启动实测 < 1.5 秒。
 */
const BOOTSTRAP_TIMEOUT_MS = 15_000

function reportBootstrapPerf(): void {
  if (bootPerfReported) return
  bootPerfReported = true
  const end = performance.now()
  try {
    performance.mark(`${BOOT_PERF_NAME}:end`)
    performance.measure(BOOT_PERF_NAME, { start: BOOT_PERF_START, end })
  } catch {
    // performance API 不可用（极旧内核）不影响启动
  }
  console.info(`[perf] bootstrap ${Math.round(end - BOOT_PERF_START)}ms`)
}

/**
 * 应用外壳：启动时拉快照灌 store，订阅主进程事件，按 view 渲染。
 * 顶栏的标题/计数口径也在这里统一（分组名、未分组筛选、视图），避免各组件各算一套。
 */
export function App(): JSX.Element {
  // 订阅语言变化：切换语言时整个壳重渲染，t() 才会取到新字典
  useLocale()

  const view = useUiStore((state) => state.view)
  const groupId = useUiStore((state) => state.groupId)
  const setGroup = useUiStore((state) => state.setGroup)
  const filters = useUiStore((state) => state.filters)
  const toggleFilter = useUiStore((state) => state.toggleFilter)
  const bootstrapped = useUiStore((state) => state.bootstrapped)
  const setBootstrapped = useUiStore((state) => state.setBootstrapped)

  const settings = useSettingsStore((state) => state.settings)
  const applySnapshot = useSettingsStore((state) => state.applySnapshot)
  const connections = useConnectionStore((state) => state.items)
  const groups = useGroupStore((state) => state.items)
  // 启动失败必须能看见、能重试。旧实现只 push 一条 toast 就 return，
  // bootstrapped 永远是 false，界面永久停在「正在启动」，用户只能杀进程。
  const [bootError, setBootError] = useState<{ code: string; message: string } | null>(null)
  const [bootAttempt, setBootAttempt] = useState(0)
  /** 首启欢迎页；与导入向导互斥，bootstrap 决定先开哪一个（欢迎页优先） */
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  /**
   * 托盘事件可能在 state 已提交、effect 尚未重订阅的缝隙里到达，
   * 这里同步维护一份 ref，保证「欢迎页是否开着」永远是最新值。
   */
  const welcomeOpenRef = useRef(false)
  /** 主进程数据版本：bootstrap 给初值，之后靠 data.sync 推进 */
  const dataVersionRef = useRef<number | null>(null)
  const closeWelcome = useCallback((): void => {
    welcomeOpenRef.current = false
    setWelcomeOpen(false)
  }, [])

  useTheme()
  useConnStateEvents()
  useKeyboardShortcuts()
  // 数据健康态（写盘失败 / 只读 / 密码解不开）：常驻横幅的数据源
  const { health, refresh: refreshHealth } = useDataHealth()

  useEffect(() => {
    let alive = true
    let settled = false
    setBootError(null)
    setBootstrapped(false)
    /*
     * 超时守卫：只在"还没有任何结果"时生效。超时后主进程的 bootstrap 仍可能
     * 迟一步 resolve——alive/settled 两个标记保证它不会再改界面（否则用户刚点重试
     * 就被上一轮的结果覆盖）。
     */
    const timer = window.setTimeout(() => {
      if (!alive || settled) return
      settled = true
      setBootError({ code: 'TIMEOUT', message: '' })
      setBootstrapped(true)
      reportBootstrapPerf()
    }, BOOTSTRAP_TIMEOUT_MS)
    void window.api.app.bootstrap().then((res) => {
      if (!alive) return
      settled = true
      window.clearTimeout(timer)
      if (!res.ok) {
        setBootError({ code: res.error.code, message: res.error.message })
        setBootstrapped(true) // 放行 loading，让错误页能渲染出来
        reportBootstrapPerf()
        return
      }
      applySnapshot(res.data.settings)
      useConnectionStore.getState().replaceAll(res.data.connections)
      useGroupStore.setState({ items: res.data.groups })
      // 记下版本号供增量同步使用；旧 preload 不带该字段时退化为 null（不做增量）
      dataVersionRef.current = res.data.version ?? null
      setBootstrapped(true)
      reportBootstrapPerf()
      // 首屏数据到位后再探一次健康态：启动期的写盘失败/解密失败这时才有结论
      refreshHealth()
      /*
       * R24：用落盘的探测快照给连通性灯补水。
       *
       * 用户口径「主界面灯跟实际状态不符，已探测显示未知」：probeStore 只在内存，
       * 而健康历史是落盘的——重启后「探测与健康」写着今天探测过，主界面却是一排
       * 空心未知。这里在首屏之后异步拉一次健康报告灌进 store（只补"比本地更新"
       * 的结论），列表与健康页从此同一口径。失败静默：下一轮探测自然会填上。
       */
      void window.api.monitor
        .report()
        .then((report) => {
          if (!alive || !report.ok) return
          useProbeStore.getState().hydrate(
            report.data.entries.flatMap((entry) =>
              // 'checking' 不是落盘结论（只在探测瞬间出现），不参与补水
              entry.state === 'checking'
                ? []
                : [
                    {
                      connectionId: entry.connectionId,
                      state: entry.state,
                      latencyMs: entry.latencyMs,
                      checkedAt: entry.checkedAt,
                      failCode: entry.failCode
                    }
                  ]
            )
          )
        })
        .catch(() => undefined)
      /*
       * 首屏之后自动识别真实主机名：只处理名称仍等于 IP 的导入记录。
       * 必须 fire-and-forget —— DNS/NBT 反查再慢也不能拖住界面；
       * 失败静默（store 内部吞掉），用户仍可用 IP/端口正常连接。
       */
      void useConnectionStore.getState().resolveNames()
      /*
       * 首次启动只允许一个浮层拿焦点：欢迎页优先级高于导入向导。
       * - 库里已有连接（老用户 / 已有数据）不弹欢迎页，并记为已读，
       *   避免以后清空数据时突然补弹一次；
       * - 欢迎页展示期间不自动打开导入向导，用户点「从 Windows 导入」后再打开；
       * - 启动期间用户已从托盘/快捷键打开了抽屉或向导时，不再叠欢迎页；
       * - 欢迎页不需要 / 已读时，维持原有的导入向导自动弹出逻辑。
       */
      const ui = useUiStore.getState()
      const overlayBusy =
        overlayIsActive() || ui.drawer.open || ui.importWizard.open || ui.confirm.open
      const welcomePending = shouldShowWelcome()
      if (overlayBusy) {
        if (welcomePending) markWelcomeShown()
      } else if (welcomePending && res.data.connections.length === 0) {
        welcomeOpenRef.current = true
        setWelcomeOpen(true)
      } else {
        if (welcomePending) markWelcomeShown()
        if (res.data.shouldShowImportWizard) ui.openImportWizard()
      }
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // bootstrap 只在挂载时跑一次；bootAttempt 变化时重跑（重试）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootAttempt])

  // 设置被主进程改动（托盘/主题联动）时同步到本地快照
  useEffect(() => {
    return window.api.events.onSettings((next) => applySnapshot(next))
  }, [applySnapshot])

  /**
   * 数据增量同步：bootstrap 已给过全量 + 版本号，之后只问"自那以后变了什么"。
   * `full: true` 表示主进程算不出增量（首次 / since 太旧 / 整体替换），此时按整包替换；
   * 增量只告诉我们"哪些 id 变了"，合并仍交给 store 自己的 loader——主进程内存态，代价可接受。
   * 触发时机只看窗口聚焦与 60s 轮询：本应用的数据变更都发生在本机，不需要长连接。
   */
  useEffect(() => {
    const flush = async (): Promise<void> => {
      const since = dataVersionRef.current
      if (since === null) return
      const res = await window.api.data.sync({ since })
      if (!res.ok) return
      const payload = res.data
      if (payload.version <= since) return
      dataVersionRef.current = payload.version
      if (payload.full) {
        useConnectionStore.getState().replaceAll(payload.connections ?? [])
        useGroupStore.setState({ items: payload.groups ?? [] })
        if (payload.settings) applySnapshot(payload.settings)
        return
      }
      if (payload.changes.some((change) => change.kind !== 'settings')) {
        void useConnectionStore.getState().load()
        void useGroupStore.getState().load()
      }
    }
    const timer = window.setInterval(() => void flush(), 60_000)
    const onFocus = (): void => void flush()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [applySnapshot])

  /**
   * 视图 / 分组 / 搜索 / 筛选一变，就取消在跑的探测批次。
   *
   * 为什么用 store.subscribe 而不是 effect 依赖：setView/setSearch/toggleFilter
   * 是同步触发的，这里能在同一 tick 内先发取消，再让新视图挂载后发起下一批；
   * 用 effect 依赖则新视图的 useProbe 可能先跑，取消会把**新批次**误杀。
   * 排序/选择/抽屉等不改变可见集合，不计入 scope，不会被误取消。
   */
  useEffect(() => {
    /*
      作用域指纹 = 一切会改变"可见集合"的维度：视图 / 分组 / 搜索 / 字段筛选 /
      标签筛选 / 环境筛选（P2-3）。以前漏了 envFilter（和 tagFilters），
      切环境筛选时不取消在跑批次，旧口径的结论会写回新集合。
    */
    const scopeKey = (state: ReturnType<typeof useUiStore.getState>): string =>
      `${state.view}|${state.groupId ?? ''}|${state.searchKeyword}|${state.filters.join(',')}|${state.tagFilters.join(',')}|${state.envFilter}`
    let last = scopeKey(useUiStore.getState())
    return useUiStore.subscribe((state) => {
      const next = scopeKey(state)
      if (next === last) return
      last = next
      useProbeStore.getState().cancel()
    })
  }, [])

  // 托盘菜单 → 渲染层动作：新建连接 / 导入历史 / 设置 / 最近连接直连。
  // 托盘点击时窗口可能刚被主进程 show 出来，这里只负责切 UI 状态，不抢焦点。
  useEffect(() => {
    /** 托盘动作与欢迎页互斥：先收起欢迎页，避免它盖住设置页、表单或导入向导 */
    const dismissWelcomeForTray = (): void => {
      if (!welcomeOpenRef.current) return
      markWelcomeShown()
      closeWelcome()
    }

    const offNav = window.api.events.onNav(({ action, connectionId }) => {
      dismissWelcomeForTray()
      const ui = useUiStore.getState()
      if (action === 'new') ui.openDrawer('create')
      else if (action === 'import') ui.openImportWizard()
      else if (action === 'settings') ui.setView('settings')
      else if (action === 'edit' && connectionId) {
        // 会话窗口标签菜单里的「编辑连接设置」：先切回全部主机并选中，再打开编辑抽屉
        ui.setView('all')
        ui.select(connectionId)
        ui.openDrawer('edit', connectionId)
      }
    })
    const offConnect = window.api.events.onTrayConnect(({ connectionId }) => {
      dismissWelcomeForTray()
      useUiStore.getState().select(connectionId)
      const conn = useConnectionStore.getState().items.find((item) => item.id === connectionId)
      // 托盘「连接」同样不能绕过生产环境二次确认
      if (conn) {
        confirmProdConnect(conn, () =>
          confirmUnreachable(conn, () =>
            void useConnectionStore.getState().connect(connectionId)
          )
        )
      } else {
        void useConnectionStore.getState().connect(connectionId)
      }
    })
    // 会话窗口里改了剪贴板/驱动器/音频：就地更新列表与后续连接使用的记录
    const offUpdated = window.api.events.onConnUpdated((conn) => {
      useConnectionStore.getState().upsert(conn)
    })
    /*
     * 矩阵窗口交办：「编辑连接」「批量编辑」统一回到主窗口的表单。
     * 先保证主窗口在正确的视图（全部主机 + 清筛选），否则抽屉/对话框打开后
     * 目标连接可能不在当前列表里，用户看到的是"点了没反应"。
     */
    const offBatchEdit = window.api.events.onOpenBatchEdit(({ ids }) => {
      dismissWelcomeForTray()
      useUiStore.getState().requestBatchEdit(ids)
    })
    const offEdit = window.api.events.onOpenEdit(({ connectionId }) => {
      dismissWelcomeForTray()
      const ui = useUiStore.getState()
      ui.setView('all')
      ui.select(connectionId)
      ui.openDrawer('edit', connectionId)
    })
    return () => {
      offNav()
      offConnect()
      offUpdated()
      offBatchEdit()
      offEdit()
    }
  }, [closeWelcome])

  // F1 打开帮助。任何浮层打开时都不再叠一层（包括帮助自己已打开的情况）；
  // 启动中 / 启动失败页没有帮助可看，不抢默认焦点。
  useEffect(() => {
    if (!bootstrapped || bootError !== null || settings === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F1') return
      event.preventDefault()
      if (overlayIsActive()) return
      useHelpStore.getState().openHelp()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bootstrapped, bootError, settings])

  if (!bootstrapped) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] rp-text-body text-t3">
        {t('app.starting')}
      </div>
    )
  }

  if (bootError) {
    const timedOut = bootError.code === 'TIMEOUT'
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[var(--bg)] px-8">
        <div className="rp-text-body-l font-semibold text-t1">
          {timedOut ? t('b4d.boot.timeoutTitle') : t('app.initFailed')}
        </div>
        <div className="max-w-[460px] text-center rp-text-body leading-relaxed text-t2">
          {timedOut ? t('b4d.boot.timeoutBody') : errorText(bootError.code, bootError.message)}
        </div>
        <Button variant="primary" size="sm" className="mt-1" onClick={() => setBootAttempt((n) => n + 1)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] rp-text-body text-t3">
        {t('app.starting')}
      </div>
    )
  }

  const activeGroup = groups.find((item) => item.id === groupId) ?? null
  /**
   * 「未分组」复用列表工具栏的 `ungrouped` 筛选维度（不是虚构分组）：
   * 标题/计数在这里统一口径，否则侧栏选中"未分组"而顶栏写"全部主机 · 29"会自相矛盾。
   */
  const ungrouped = groupId === null && filters.includes('ungrouped')
  const ungroupedCount = connections.filter((item) => !item.groupId).length
  const total =
    view === 'favorites'
      ? connections.filter((item) => item.favorite).length
      : view === 'recent'
        ? connections.filter((item) => item.lastConnectedAt).length
        : ungrouped
          ? ungroupedCount
          : activeGroup
            ? connections.filter((item) => item.groupId === activeGroup.id).length
            : connections.length

  /** 顶栏「取消筛选」：既要退出分组，也要摘掉 ungrouped 筛选，否则看起来没反应 */
  const clearScope = (): void => {
    setGroup(null)
    if (filters.includes('ungrouped')) toggleFilter('ungrouped')
  }

  /*
   * 欢迎页三个动作都先关自己、再开下一个浮层（localStorage 的已读标记由
   * WelcomeDialog 统一写入）。同一个 tick 内 React 批量提交：欢迎页 Modal 卸载
   * 的同时向导/抽屉挂载，同一时刻只有一个浮层持有焦点。
   */
  const handleWelcomeClose = closeWelcome
  const handleWelcomeImport = (): void => {
    closeWelcome()
    useUiStore.getState().openImportWizard()
  }
  const handleWelcomeCreate = (): void => {
    closeWelcome()
    useUiStore.getState().openDrawer('create')
  }

  return (
    <>
      <AppShell
        connections={connections}
        groups={groups}
        total={total}
        groupName={ungrouped ? t('nav.ungrouped') : (activeGroup?.name ?? null)}
        onClearGroup={clearScope}
      >
        {/*
         * 数据健康横幅放在内容区顶部（而不是 Toast）：写盘失败/只读/密码解不开是
         * 持续状态，用户点掉提示后会继续录入，每一次都没保存——那正是静默丢数据。
         */}
        <DataHealthBanner health={health} onRefresh={refreshHealth} />
        {view === 'settings' ? (
          <SettingsView />
        ) : view === 'favorites' ? (
          <HostListView variant="favorites" />
        ) : view === 'recent' ? (
          <HostListView variant="recent" />
        ) : (
          <HostListView variant="all" />
        )}
      </AppShell>

      <ConnectionDrawer />
      <ImportWizard />
      <WelcomeDialog
        open={welcomeOpen}
        onClose={handleWelcomeClose}
        onImport={handleWelcomeImport}
        onCreate={handleWelcomeCreate}
      />
      <HelpDialog />
      <CommandPalette />
      <Onboarding />
      <HealthAlertHost />
      <CredentialLockOverlay />

      <ConfirmDialog />
      <ToastHost />
    </>
  )
}
