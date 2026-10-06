import type { EntryRow } from '@/data/types'

/**
 * 通风机组判定口径：全站只维护这一份。
 * 看板、值守汇总、点检入口都调这里的函数，结论要变只改这里。
 */

// 集中配置：有害气体浓度上限（%）与送风量下限（m³/min）。
// 看板与汇总都从这里取数，调整阈值只改这一处，已登记的读数按新口径重算。
export const VENTILATION_LIMITS = {
  gasMax: 0.5,
  airflowMin: 300,
} as const

// 规则版本：判定算法调整时递增。
// 生效结论按当前版本实时重算；停机留档仍按写入时的版本与结论封存，不回改。
export const VENTILATION_RULE_VERSION = 1

export const VENTILATION_STATUS = {
  pending: '待启动',
  running: '运行中',
  stopped: '已停机',
  fault: '故障',
} as const

export type VentilationVerdict = {
  /** 生效结论：四个状态之一，三个入口统一用它 */
  status: string
  /** 读数是否越限（浓度超上限或送风量低于下限） */
  overLimit: boolean
  /** 判定依据，页面直接展示，免得现场靠猜 */
  reasons: string[]
}

export function toReading(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 一台机组的生效结论。判定优先级（冲突时靠前者为准）：
 * 1. 登记「故障」：报修停机，压住一切读数，禁止再启动；
 * 2. 登记「已停机」：停机检修期间读数不再翻转结论；
 * 3. 读数越限：有害气体浓度超上限或送风量低于下限，一律按停机记（超限）；
 * 4. 其余按登记状态（待启动 / 运行中）。
 */
export function evaluateUnit(
  row: EntryRow,
  limits: { gasMax: number; airflowMin: number } = VENTILATION_LIMITS,
): VentilationVerdict {
  const registered = String(row.status ?? '')
  const gas = toReading(row['有害气体浓度'])
  const airflow = toReading(row['送风量'])
  const breaches: string[] = []

  if (gas !== null && gas > limits.gasMax) {
    breaches.push(`有害气体浓度 ${gas} 超上限 ${limits.gasMax}`)
  }
  if (airflow !== null && airflow < limits.airflowMin) {
    breaches.push(`送风量 ${airflow} 低于下限 ${limits.airflowMin}`)
  }
  const overLimit = breaches.length > 0

  if (registered === VENTILATION_STATUS.fault) {
    return {
      status: VENTILATION_STATUS.fault,
      overLimit,
      reasons: ['登记报修，故障结论优先，禁止再启动', ...breaches],
    }
  }
  if (registered === VENTILATION_STATUS.stopped) {
    return {
      status: VENTILATION_STATUS.stopped,
      overLimit,
      reasons: ['登记停机检修，停机期间读数不翻转结论', ...breaches],
    }
  }
  if (overLimit) {
    return { status: VENTILATION_STATUS.stopped, overLimit, reasons: breaches }
  }
  return {
    status: registered || VENTILATION_STATUS.pending,
    overLimit,
    reasons: ['读数在限值内'],
  }
}

export type VentilationSummary = {
  total: number
  /** 生效结论为「运行中」 */
  running: number
  /** 生效结论为「已停机」（含超限按停机记的） */
  stopped: number
  /** 生效结论为「故障」 */
  fault: number
  /** 读数越限台数 */
  overLimit: number
  /** 生效结论为「待启动」 */
  pending: number
}

/** 值守汇总与看板共用的同一份汇总数。 */
export function summarizeVentilation(
  rows: EntryRow[],
  limits: { gasMax: number; airflowMin: number } = VENTILATION_LIMITS,
): VentilationSummary {
  const summary: VentilationSummary = {
    total: rows.length,
    running: 0,
    stopped: 0,
    fault: 0,
    overLimit: 0,
    pending: 0,
  }
  for (const row of rows) {
    const verdict = evaluateUnit(row, limits)
    if (verdict.status === VENTILATION_STATUS.running) summary.running += 1
    else if (verdict.status === VENTILATION_STATUS.stopped) summary.stopped += 1
    else if (verdict.status === VENTILATION_STATUS.fault) summary.fault += 1
    else summary.pending += 1
    if (verdict.overLimit) summary.overLimit += 1
  }
  return summary
}

export type VentilationHazard = {
  unitId: number
  机组编号: string
  安装位置: string
  verdict: string
  reasons: string[]
}

/** 故障或读数越限的机组 → 安全巡检隐患清单，两边取的是同一份。 */
export function collectVentilationHazards(
  rows: EntryRow[],
  limits: { gasMax: number; airflowMin: number } = VENTILATION_LIMITS,
): VentilationHazard[] {
  const hazards: VentilationHazard[] = []
  for (const row of rows) {
    const verdict = evaluateUnit(row, limits)
    if (verdict.status === VENTILATION_STATUS.fault || verdict.overLimit) {
      hazards.push({
        unitId: Number(row.id),
        机组编号: String(row['机组编号'] ?? `#${row.id}`),
        安装位置: String(row['安装位置'] ?? '未登记'),
        verdict: verdict.status,
        reasons: verdict.reasons,
      })
    }
  }
  return hazards
}
