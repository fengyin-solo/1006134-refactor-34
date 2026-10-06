import { listRows, saveMany } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import {
  VENTILATION_LIMITS,
  VENTILATION_RULE_VERSION,
  VENTILATION_STATUS,
  collectVentilationHazards,
  evaluateUnit,
  summarizeVentilation,
} from '@/domain/ventilation'
import type { VentilationHazard, VentilationSummary, VentilationVerdict } from '@/domain/ventilation'

/**
 * 通风机组的读写入口：看板、值守汇总、点检入口、安全巡检联动都从这里取数，
 * 判定算法本身在 @/domain/ventilation，只有一份。
 */

const MODULE_KEY = 'ventilation'
// 停机留档单独存一个键：写进去就封存，算法变了也不回改。
const STOP_LOG_KEY = 'ventilation_stop_log'

// 送风量只允许本工区通风负责人改动。
export const VENTILATION_LEAD_ROLE = '通风负责人'

export type VentilationOperator = {
  name: string
  role: string
}

export type VentilationUnit = {
  row: EntryRow
  verdict: VentilationVerdict
}

const LOCATION_FALLBACK = '历史补登（安装位置待核）'

// 历史机组数据补登：老数据没有「安装位置」，读取时补登并一次性写回。
function ensureLocations(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    if (typeof row['安装位置'] === 'string' && row['安装位置'].trim() !== '') {
      return row
    }
    changed = true
    return { ...row, 安装位置: LOCATION_FALLBACK }
  })
  return { rows: changed ? next : rows, changed }
}

function loadRows(): EntryRow[] {
  const { rows, changed } = ensureLocations(listRows(MODULE_KEY))
  if (changed) {
    saveMany({ [MODULE_KEY]: rows })
  }
  return rows
}

/** 机组列表 + 逐台生效结论，点检入口与值守汇总共用。 */
export function listVentilationUnits(): VentilationUnit[] {
  return loadRows().map((row) => ({ row, verdict: evaluateUnit(row) }))
}

/** 看板、值守汇总、安全巡检读的同一份汇总数。 */
export function loadVentilationSummary(): VentilationSummary {
  return summarizeVentilation(loadRows())
}

/** 与安全巡检隐患清单联动的同一份隐患机组。 */
export function loadVentilationHazards(): VentilationHazard[] {
  return collectVentilationHazards(loadRows())
}

/** 停机留档：按写入时的规则版本与结论封存，只增不改。 */
export function loadVentilationStopLog(): EntryRow[] {
  return listRows(STOP_LOG_KEY)
}

function appendStopLog(
  log: EntryRow[],
  row: EntryRow,
  action: string,
  verdict: VentilationVerdict,
  operator: VentilationOperator,
): EntryRow[] {
  const nextId = log.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: verdict.status,
    pending: false,
    abnormal: verdict.status === VENTILATION_STATUS.fault || verdict.overLimit,
    机组编号: String(row['机组编号'] ?? `#${row.id}`),
    安装位置: String(row['安装位置'] ?? LOCATION_FALLBACK),
    操作: action,
    判定结论: verdict.status,
    判定依据: verdict.reasons.join('；'),
    规则版本: `v${VENTILATION_RULE_VERSION}`,
    浓度上限: VENTILATION_LIMITS.gasMax,
    风量下限: VENTILATION_LIMITS.airflowMin,
    操作人: operator.name,
    登记时间: new Date().toISOString(),
  }
  return [...log, entry]
}

const IDEMPOTENT_MESSAGE = '与首次操作结果一致，不重复落档'

/**
 * 机组状态流转。先校验后落库：任何一步不通过就什么都不写；
 * 通过则机组表与停机留档在同一次存储写入里一起落，不留半条。
 * 同一个动作连着点两回，仍按头一回的结果返回，不重复落档。
 */
export function runVentilationAction(
  id: number,
  action: string,
  operator: VentilationOperator,
): ActionResult {
  const rows = loadRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的通风机组` }
  }
  const row = rows[index]
  const registered = String(row.status ?? '')
  const verdict = evaluateUnit(row)

  if (action === '启动机组') {
    if (registered === VENTILATION_STATUS.fault) {
      return { ok: false, message: '报修停机（故障）中的机组禁止再启动，越权改动直接驳回' }
    }
    if (verdict.overLimit) {
      return { ok: false, message: `读数越限（${verdict.reasons.join('；')}），禁止启动` }
    }
    if (registered === VENTILATION_STATUS.running) {
      return { ok: true, message: `机组已在运行中，${IDEMPOTENT_MESSAGE}` }
    }
    const next = [...rows]
    next[index] = { ...row, status: VENTILATION_STATUS.running, pending: true }
    saveMany({ [MODULE_KEY]: next })
    return { ok: true, message: '机组已启动，当前状态「运行中」' }
  }

  if (action === '停机检修' || action === '登记故障') {
    const target = action === '停机检修' ? VENTILATION_STATUS.stopped : VENTILATION_STATUS.fault
    if (registered === target) {
      return { ok: true, message: `机组已是「${target}」，${IDEMPOTENT_MESSAGE}` }
    }
    if (target === VENTILATION_STATUS.stopped && registered === VENTILATION_STATUS.fault) {
      return { ok: true, message: `机组已是「故障」，故障结论优先，${IDEMPOTENT_MESSAGE}` }
    }
    const nextRow: EntryRow = {
      ...row,
      status: target,
      pending: false,
      abnormal: target === VENTILATION_STATUS.fault ? true : row.abnormal,
    }
    const nextRows = [...rows]
    nextRows[index] = nextRow
    // 留档按当时（即现在）的规则版本与结论封存。
    const nextLog = appendStopLog(
      listRows(STOP_LOG_KEY),
      nextRow,
      action,
      evaluateUnit(nextRow),
      operator,
    )
    saveMany({ [MODULE_KEY]: nextRows, [STOP_LOG_KEY]: nextLog })
    return { ok: true, message: `机组已${action}，当前状态「${target}」，停机留档已封存` }
  }

  return { ok: false, message: `通风机组没有登记「${action}」这个动作` }
}

/** 调整送风量：只允许本工区通风负责人改动，其余角色直接驳回。 */
export function adjustAirflow(id: number, value: number, operator: VentilationOperator): ActionResult {
  if (operator.role !== VENTILATION_LEAD_ROLE) {
    return { ok: false, message: `送风量只允许本工区${VENTILATION_LEAD_ROLE}改动，越权改动直接驳回` }
  }
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: '送风量必须是大于 0 的数字，未写入任何数据' }
  }
  const rows = loadRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的通风机组` }
  }
  const row = rows[index]
  if (Number(row['送风量']) === value) {
    return { ok: true, message: `送风量已是 ${value}，${IDEMPOTENT_MESSAGE}` }
  }
  const next = [...rows]
  next[index] = { ...row, 送风量: value }
  saveMany({ [MODULE_KEY]: next })
  // 读数变更后，生效结论按当前口径在下次读取时自动重算。
  return { ok: true, message: `送风量已调整为 ${value}，机组结论已按当前口径重算` }
}
