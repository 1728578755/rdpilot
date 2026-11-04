/**
 * 组织层：连接模板（继承的一种轻量实现）、保存的筛选视图、重复检测。
 * 模板只保存「除 host/name 之外的可复用配置」，避免模板里藏一台幽灵主机。
 */
import type {
  AudioMode,
  ColorDepth,
  ConnectionGateway,
  DisplayMode,
  EnvironmentKind,
  LayoutMode,
  Resolution,
  SessionOverride
} from '../types'
import type { AdvancedRdpOptions } from './rdp'

export interface TemplateValues {
  groupId: string | null
  colorTag: string
  displayMode: DisplayMode
  resolution: Resolution | null
  colorDepth: ColorDepth
  audioMode: AudioMode
  clipboard: boolean
  drives: boolean
  printers: boolean
  smartCard: boolean
  serial: boolean
  camera: boolean
  tags: string[]
  environment: EnvironmentKind
  gateway: ConnectionGateway | null
  adminSession: boolean
  alternateShell: string | null
  sessionOverride: SessionOverride
  smartSizing: boolean
  advanced: AdvancedRdpOptions
}

export interface ConnectionTemplate {
  id: string
  name: string
  description: string | null
  values: TemplateValues
  createdAt: number
  updatedAt: number
}

export interface ConnectionTemplateInput {
  id?: string
  name: string
  description: string | null
  values: TemplateValues
}

export type SavedViewSort = 'name' | 'recent' | 'host' | 'group' | 'created'

export interface SavedView {
  id: string
  name: string
  icon: string | null
  query: string
  groupId: string | null
  tagFilters: string[]
  environments: EnvironmentKind[]
  favoritesOnly: boolean
  layout: LayoutMode
  sort: SavedViewSort
  createdAt: number
}

export interface SavedViewInput {
  id?: string
  name: string
  icon: string | null
  query: string
  groupId: string | null
  tagFilters: string[]
  environments: EnvironmentKind[]
  favoritesOnly: boolean
  layout: LayoutMode
  sort: SavedViewSort
}

export interface DuplicateGroup {
  key: string
  connectionIds: string[]
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  total: number
}
