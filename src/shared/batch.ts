/**
 * 批量编辑 / 标签维护的跨进程契约（主进程 / preload / 渲染层共用）。
 *
 * 为什么单独一个文件而不是塞进 types.ts：本批次的 `Connection` 实体已经冻结，
 * 批量补丁只是**动作载荷**，不是持久化实体字段。放在独立文件里可以避免
 * 每次加一个批量维度都去碰实体定义（也就不会和 foundation 的改动打架）。
 */
import type { CertPolicy, RdpAuthenticationLevel } from './domain/rdp'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  DisplayMode,
  EnvironmentKind,
  Resolution
} from './types'

/**
 * 批量编辑补丁：只有**显式出现**的字段会被修改，缺省字段保持原值。
 *
 * 标签语义：
 *  - `tagsAdd`    追加（大小写不敏感去重，受 12 个 / 单个 24 字符上限约束）；
 *  - `tagsRemove` 移除（大小写不敏感匹配）；
 *  - `tagsSet`    直接覆盖为这一组（优先级最高；为空数组 = 清空全部标签）。
 * 三者可以同时给出，应用顺序固定为 set → add → remove。
 */
export interface ConnectionBatchPatch {
  /** null = 移到未分组；undefined = 不改 */
  groupId?: string | null
  /** '' = 无色；undefined = 不改 */
  colorTag?: string
  environment?: EnvironmentKind
  tagsAdd?: string[]
  tagsRemove?: string[]
  tagsSet?: string[]
  displayMode?: DisplayMode
  /**
   * 分辨率：null = 跟随窗口；{w,h} = 固定分辨率。
   * 只在连接最终是窗口模式时有意义（其余模式由执行器忽略，与单条更新的口径一致）。
   */
  resolution?: Resolution | null
  colorDepth?: ColorDepth
  audioMode?: AudioMode
  /**
   * 证书校验档：写进 `advanced.authenticationLevel`（'default' = 跟随全局设置）。
   * 批量改安全策略必须显式给出，缺省绝不修改——避免"顺手把生产机的校验关掉"。
   *
   * @deprecated 证书策略的唯一入口是 `certPolicy`（三态）。此字段只保留给旧调用方：
   * 新代码一律写 `certPolicy`，主进程会把它镜像到 `advanced.authenticationLevel`。
   */
  authenticationLevel?: RdpAuthenticationLevel
  /**
   * 每连接证书策略三态（R5 #082 / #340）：`inherit` 跟随全局、`verify` 校验失败即拒绝、
   * `skip` 不校验。批量写入必须同时写 `connect-extras.json`（渲染层在 batchUpdate 之后
   * 调 `connectExtras.setMany`），两个入口共用同一份真相源，否则抽屉会显示成旧值。
   */
  certPolicy?: CertPolicy
}

/** 批量更新的返回：`updated` 是实际写入条数，`connections` 是写入后的完整记录 */
export interface ConnectionBatchResult {
  updated: number
  connections: Connection[]
}

/** 标签重命名结果：`updated` 是受影响连接数（不是标签出现总次数） */
export interface TagRenameResult {
  from: string
  to: string
  updated: number
  connections: Connection[]
}

/** 标签删除结果：只解除关联，绝不删除连接本身 */
export interface TagDeleteResult {
  tag: string
  updated: number
  connections: Connection[]
}
