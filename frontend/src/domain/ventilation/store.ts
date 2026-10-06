import { EXTRA_SEED_FANS, POSITION_LEDGER, SEED_ARCHIVES } from './seed'
import { reconcileState } from './reconcile'
import type { EntryRow } from '../../data/types'
import { invalidateRowsCache } from '../../data/local-store'
import type { StopArchive, VentFan, VentState } from './types'

// 通风域独立持久化：与通用台账分开，三个入口只认这里的一份。
const STORAGE_KEY = 'shield-tunnel-construction:ventilation'
// 旧的通用台账键：首启迁移时从这里把历史通风机组捞出来补登，迁移后清空该模块旧数据。
const LEGACY_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

/** 从旧通用台账读取通风历史机组；取不到（如 Node 测试环境）返回空数组。 */
function readLegacyVentRows(): EntryRow[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return Array.isArray(parsed.ventilation) ? parsed.ventilation : []
  } catch {
    return []
  }
}

/** 迁移后清掉旧台账里的通风模块，避免别处明细与这里各说各话。 */
function clearLegacyVentRows(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY)
    if (!raw) {
      return
    }
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    if (!Array.isArray(parsed.ventilation)) {
      return
    }
    delete parsed.ventilation
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(parsed))
  } catch {
    // 旧数据损坏不影响通风域自身落盘
  }
}

function isRepairLegacy(row: EntryRow): boolean {
  return String(row.status) === '故障'
}

/**
 * 历史机组数据按安装位置补登：老数据按机组编号查位置台账，补入安装位置、工区与读数；
 * 台账查不到的不捏造，位置标记「安装位置待核实」、工区留空（页面上醒目提示）。
 */
function migrateLegacyFan(row: EntryRow, id: number): VentFan {
  const code = String(row['机组编号'] ?? `HIST-${id}`)
  const compact = code.replace(/-/g, '_')
  const ledger = POSITION_LEDGER[code] ?? POSITION_LEDGER[compact]
  return {
    id,
    code,
    location: ledger?.location ?? '安装位置待核实',
    area: ledger?.area ?? '',
    airflow: ledger ? ledger.airflow : toNumber(row['送风量']),
    gas: ledger ? ledger.gas : toNumber(row['有害气体浓度']),
    temperature: ledger ? ledger.temperature : toNumber(row['洞内温度']),
    switchOn: String(row.status) === '运行中',
    repairLock: isRepairLegacy(row),
    checkedAt: String(row['检测日期'] ?? ledger?.checkedAt ?? ''),
    keeper: ledger?.keeper ?? String(row['值守人员'] ?? ''),
    source: '历史补登',
    note: ledger
      ? '按安装位置台账补登的历史机组'
      : '历史机组：位置台账未收录，安装位置与工区待核实',
  }
}

/**
 * 构造首启状态：旧台账通风记录迁移补登 + 通风域新登记机组 + 历史留档。
 * 纯函数（now 由参数注入），供浏览器首启与测试共用。
 */
export function buildInitialState(legacyRows: EntryRow[], nowIso: string): VentState {
  const migratedFans = legacyRows.map((row, index) => migrateLegacyFan(row, index + 1))
  const extraFans: VentFan[] = EXTRA_SEED_FANS.map((fan, index) => ({
    ...fan,
    id: migratedFans.length + index + 1,
    source: '正常登记',
  }))
  const fans = [...migratedFans, ...extraFans]
  const codeToId = new Map(fans.map((fan) => [fan.code, fan.id]))

  const archives: StopArchive[] = SEED_ARCHIVES.map((item, index) => ({
    ...item,
    id: index + 1,
    fanId: codeToId.get(item.fanCode) ?? -1,
  })).filter((item) => item.fanId > 0)

  return reconcileState(
    {
      fans,
      archives,
      hazards: [],
      seq: { fan: fans.length, archive: archives.length },
      migrated: true,
    },
    nowIso,
  )
}

function readStored(): VentState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as VentState
    if (!Array.isArray(parsed.fans) || !Array.isArray(parsed.archives)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

let cache: VentState | null = null

/**
 * 首启引导，只跑一次：
 * 已迁移过直接读通风域存储；否则迁移旧台账、补登历史机组、组装留档、对账隐患并整体落盘。
 */
export function bootstrapVent(nowIso: string): VentState {
  if (cache) {
    return cache
  }
  const stored = readStored()
  if (stored && stored.migrated) {
    cache = stored
    return stored
  }
  const initial = buildInitialState(readLegacyVentRows(), nowIso)
  cache = initial
  persist(initial)
  clearLegacyVentRows()
  invalidateRowsCache()
  return initial
}

export function getVentState(): VentState {
  if (!cache) {
    return bootstrapVent(new Date().toISOString())
  }
  return cache
}

/** 整体落盘：调用方必须先在内存里拼好完整的新状态，绝不半条写入。 */
export function persist(state: VentState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

/** 测试与「重置为示例数据」使用：替换整份状态并落盘。 */
export function replaceVentState(state: VentState): void {
  persist(state)
}

/** 测试隔离：清掉内存缓存（不碰浏览器存储）。 */
export function resetVentCache(): void {
  cache = null
}

export function ventStorageKey(): string {
  return STORAGE_KEY
}

export { clone as cloneVentState }
