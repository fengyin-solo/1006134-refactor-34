import { VENT_RULE } from './config'
import { evaluateFan, evaluateFans } from './judgment'
import { reconcileState } from './reconcile'
import { bootstrapVent, getVentState, persist } from './store'
import type {
  FanEvaluation,
  Operator,
  StopArchive,
  VentFan,
  VentHazard,
  VentResult,
  VentState,
} from './types'

/**
 * 通风域唯一服务：看板、值守汇总、点检入口、安全巡检全部只通过这里取数与写入。
 * - 阈值只从 VENT_RULE 取，结论只由 judgment.ts 的唯一算法给出；
 * - 所有写操作先校验后落盘，校验失败原样返回驳回、状态零改动（写不成就别落半条）；
 * - 每次写入生成整份新状态、对账隐患后一次 persist（原子）；
 * - 同一动作连着点两回结果一致，不重复产生留档/隐患（幂等）。
 */

function nowIso(): string {
  return new Date().toISOString()
}

function isVentLead(op: Operator): boolean {
  return op.role === '通风负责人'
}

function sameArea(op: Operator, fan: VentFan): boolean {
  return fan.area !== '' && op.area === fan.area
}

function findFan(state: VentState, fanId: number): VentFan | undefined {
  return state.fans.find((fan) => fan.id === fanId)
}

function nextArchiveId(state: VentState): number {
  return Math.max(state.seq.archive, ...state.archives.map((item) => item.id)) + 1
}

/** 追加一条留档（只追加；早先记录按当时版本快照保留）。 */
function appendArchive(
  archives: StopArchive[],
  state: VentState,
  fan: VentFan,
  kind: StopArchive['kind'],
  reason: string,
  op: Operator,
  verdictSnapshot: FanEvaluation['verdict'],
): StopArchive[] {
  return [
    ...archives,
    {
      id: nextArchiveId(state),
      fanId: fan.id,
      fanCode: fan.code,
      area: fan.area,
      kind,
      ruleVersion: VENT_RULE.ruleVersion,
      verdictSnapshot,
      airflowSnapshot: fan.airflow,
      gasSnapshot: fan.gas,
      reason,
      operator: op.name,
      recordedAt: nowIso(),
      active: true,
    },
  ]
}

// ---------- 取数（三个入口 + 安全巡检共用） ----------

export type VentBoardSummary = {
  total: number
  running: number
  stopped: number
  fault: number
  gasOverLimit: number
  ruleVersion: number
  gasLimitPercent: number
  airflowFloor: number
}

export function getEvaluations(): FanEvaluation[] {
  const state = getVentState()
  return evaluateFans(state.fans, state.archives)
}

export function getEvaluation(fanId: number): FanEvaluation | undefined {
  const state = getVentState()
  const fan = findFan(state, fanId)
  return fan ? evaluateFan(fan, state.archives) : undefined
}

/** 看板与值守汇总的台数都从这里取：同一台机组不会出现两种台数。 */
export function getBoardSummary(): VentBoardSummary {
  const evaluations = getEvaluations()
  return {
    total: evaluations.length,
    running: evaluations.filter((item) => item.running).length,
    stopped: evaluations.filter((item) => item.stopped).length,
    fault: evaluations.filter((item) => item.fault).length,
    gasOverLimit: evaluations.filter((item) => item.gasOverLimit).length,
    ruleVersion: VENT_RULE.ruleVersion,
    gasLimitPercent: VENT_RULE.gasLimitPercent,
    airflowFloor: VENT_RULE.airflowFloor,
  }
}

export function getArchives(): StopArchive[] {
  return [...getVentState().archives].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
}

/** 安全巡检页读取：看板故障台数与隐患清单条数即同一份数据。 */
export function getLinkedHazards(): VentHazard[] {
  return getVentState().hazards
}

export function getOpenHazardCount(): number {
  return getVentState().hazards.filter((hazard) => hazard.status === '待整改').length
}

// ---------- 写入（权限在服务层强制，页面藏按钮只是辅助） ----------

/**
 * 启动机组：
 * - 报修检修中的机组禁止再启动（任何人，含负责人）——硬规则先于权限；
 * - 仅本工区通风负责人可启动；越权改动直接驳回；
 * - 浓度超限、送风量低于下限时不允许投运（投了也会被算法判回）；
 * - 已在运行位再点一次：按头一回的口径回成功，不重复留档。
 */
export function startFan(fanId: number, op: Operator): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (fan.repairLock) {
    return { ok: false, message: `${fan.code} 正在报修检修中，禁止启动，待检修完成闭环后再投运` }
  }
  if (!isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有通风负责人可以启动机组' }
  }
  if (!sameArea(op, fan)) {
    return { ok: false, message: `越权驳回：${fan.code} 属${fan.area || '未划分工区'}，${op.area}无权启动` }
  }
  if (fan.gas >= VENT_RULE.gasLimitPercent) {
    return { ok: false, message: `有害气体浓度 ${fan.gas}% 已达上限 ${VENT_RULE.gasLimitPercent}%，禁止启动` }
  }
  if (fan.airflow < VENT_RULE.airflowFloor) {
    return { ok: false, message: `实测送风量 ${fan.airflow} 低于下限 ${VENT_RULE.airflowFloor} m³/min，先恢复送风再启动` }
  }
  if (fan.switchOn) {
    // 幂等：连着点两回仍按头一回，不再写留档。
    return { ok: true, message: `${fan.code} 已在运行，无需重复启动` }
  }

  // 启动即恢复：关闭该机组生效中的值守停机留档（留痕保留），开关投运。
  const archives = state.archives.map((item) =>
    item.fanId === fan.id && item.active && item.kind === '值守停机'
      ? { ...item, active: false, closedAt: nowIso() }
      : item,
  )
  const next = reconcileState(
    { ...state, fans: state.fans.map((item) => (item.id === fan.id ? { ...item, switchOn: true } : item)), archives },
    nowIso(),
  )
  persist(next)
  return { ok: true, message: `${fan.code} 已启动，值守停机留档同步关闭` }
}

/** 停机检修（报修）：本工区通风负责人；锁定机组并追加报修检修留档；重复点击幂等。 */
export function stopForRepair(fanId: number, op: Operator, reason: string): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (!isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有通风负责人可以登记报修停机' }
  }
  if (!sameArea(op, fan)) {
    return { ok: false, message: `越权驳回：${fan.code} 属${fan.area || '未划分工区'}，${op.area}无权登记` }
  }
  if (fan.repairLock) {
    return { ok: true, message: `${fan.code} 已在报修检修中，无需重复登记` }
  }
  if (reason.trim() === '') {
    return { ok: false, message: '报修停机必须填写原因，未写入任何数据' }
  }
  const stoppedFan: VentFan = { ...fan, switchOn: false, repairLock: true }
  const evaluation = evaluateFan(stoppedFan, state.archives)
  const archives = appendArchive(state.archives, state, stoppedFan, '报修检修', reason.trim(), op, evaluation.verdict)
  const next = reconcileState(
    {
      ...state,
      fans: state.fans.map((item) => (item.id === fan.id ? stoppedFan : item)),
      archives,
      seq: { ...state.seq, archive: nextArchiveId(state) },
    },
    nowIso(),
  )
  persist(next)
  return { ok: true, message: `${fan.code} 已登记报修停机，机组锁定、禁止启动，并联动安全隐患清单` }
}

/** 检修完成：本工区通风负责人；解除锁定。机组能否恢复运行仍由唯一算法读数判定。 */
export function completeRepair(fanId: number, op: Operator): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (!isVentLead(op) || !sameArea(op, fan)) {
    return { ok: false, message: '越权驳回：只有本工区通风负责人可以确认检修完成' }
  }
  if (!fan.repairLock) {
    return { ok: true, message: `${fan.code} 当前不在检修中，无需重复操作` }
  }
  const archives = state.archives.map((item) =>
    item.fanId === fan.id && item.active && item.kind === '报修检修'
      ? { ...item, active: false, closedAt: nowIso() }
      : item,
  )
  const next = reconcileState(
    { ...state, fans: state.fans.map((item) => (item.id === fan.id ? { ...item, repairLock: false } : item)), archives },
    nowIso(),
  )
  persist(next)
  return { ok: true, message: `${fan.code} 检修完成，锁定解除；投运仍需满足送风与气体条件` }
}

/** 值守登记停机：值守员/通风负责人可登记；已存在生效留档时幂等驳回为「已有留档」。 */
export function dutyStop(fanId: number, op: Operator, reason: string): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (op.role !== '值守员' && !isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有值守人员可以登记值守停机' }
  }
  if (reason.trim() === '') {
    return { ok: false, message: '停机登记必须填写原因，未写入任何数据' }
  }
  const active = state.archives.find((item) => item.fanId === fan.id && item.active)
  if (active) {
    return { ok: true, message: `${fan.code} 已存在生效中的${active.kind}留档，仍按头一回事由停机，不重复登记` }
  }
  // 登记留档不改写看板开关位：裁决由「生效留档优先」完成，撤销后才能按原开关位+读数重判。
  const evaluation = evaluateFan(fan, state.archives)
  const archives = appendArchive(state.archives, state, fan, '值守停机', reason.trim(), op, evaluation.verdict)
  const next = reconcileState(
    {
      ...state,
      archives,
      seq: { ...state.seq, archive: nextArchiveId(state) },
    },
    nowIso(),
  )
  persist(next)
  return { ok: true, message: `${fan.code} 已按值守汇总登记停机，看板状态以该留档为准` }
}

/** 值守撤销停机：值守员/通风负责人；撤销后恢复与否由算法按当前读数重判。 */
export function dutyResume(fanId: number, op: Operator): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (op.role !== '值守员' && !isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有值守人员可以撤销值守停机' }
  }
  const active = state.archives.find((item) => item.fanId === fan.id && item.active && item.kind === '值守停机')
  if (!active) {
    return { ok: true, message: `${fan.code} 没有生效中的值守停机留档，仍按头一回状态呈现` }
  }
  const archives = state.archives.map((item) => (item.id === active.id ? { ...item, active: false, closedAt: nowIso() } : item))
  const next = reconcileState({ ...state, archives }, nowIso())
  persist(next)
  return { ok: true, message: `${fan.code} 值守停机留档已撤销，结论按当前读数重判` }
}

/** 点检登记读数：点检员/通风负责人；登记后三个入口立即按唯一算法重判。 */
export function submitReading(
  fanId: number,
  op: Operator,
  reading: { airflow?: number; gas?: number; temperature?: number; checkedAt: string },
): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (op.role !== '点检员' && !isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有点检人员可以登记点检读数' }
  }
  for (const [label, value] of [
    ['送风量', reading.airflow],
    ['有害气体浓度', reading.gas],
    ['洞内温度', reading.temperature],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return { ok: false, message: `${label}读数非法，整笔登记已驳回，未写入任何数据` }
    }
  }
  const updated: VentFan = {
    ...fan,
    airflow: reading.airflow ?? fan.airflow,
    gas: reading.gas ?? fan.gas,
    temperature: reading.temperature ?? fan.temperature,
    checkedAt: reading.checkedAt || fan.checkedAt,
    keeper: op.name,
  }
  // 读数更新后重新对账：故障成立/解除都会同步到安全巡检隐患清单。
  const next = reconcileState(
    { ...state, fans: state.fans.map((item) => (item.id === fan.id ? updated : item)) },
    nowIso(),
  )
  persist(next)
  const evaluation = evaluateFan(updated, next.archives)
  return { ok: true, message: `${fan.code} 点检读数已登记，唯一算法判定：${evaluation.verdict}（${evaluation.matchedReason}）` }
}

/**
 * 调整送风量：只允许本工区通风负责人改动，其余角色一律驳回。
 * 调完立即重判——若仍低于下限，看板照样显示停机。
 */
export function updateAirflow(fanId: number, op: Operator, airflow: number): VentResult {
  const state = getVentState()
  const fan = findFan(state, fanId)
  if (!fan) {
    return { ok: false, message: `没有找到编号为 ${fanId} 的通风机组` }
  }
  if (!isVentLead(op)) {
    return { ok: false, message: '越权驳回：送风量只允许通风负责人改动' }
  }
  if (!sameArea(op, fan)) {
    return { ok: false, message: `越权驳回：送风量只允许本工区通风负责人改动，${fan.code} 不属${op.area}` }
  }
  if (!Number.isFinite(airflow) || airflow < 0) {
    return { ok: false, message: '送风量数值非法，整笔改动已驳回' }
  }
  if (airflow === fan.airflow) {
    return { ok: true, message: '送风量与现值一致，仍按头一回口径，无改动' }
  }
  const updated = { ...fan, airflow }
  const next = reconcileState(
    { ...state, fans: state.fans.map((item) => (item.id === fan.id ? updated : item)) },
    nowIso(),
  )
  persist(next)
  const evaluation = evaluateFan(updated, next.archives)
  return { ok: true, message: `${fan.code} 送风量已改为 ${airflow} m³/min，重判结论：${evaluation.verdict}` }
}

/** 安全巡检侧关闭联动隐患：机组故障仍成立时禁止闭环，保证两边台数始终对齐。 */
export function closeHazard(hazardId: string, op: Operator): VentResult {
  const state = getVentState()
  const hazard = state.hazards.find((item) => item.id === hazardId)
  if (!hazard) {
    return { ok: false, message: '没有找到对应联动隐患' }
  }
  if (op.role !== '安全员' && !isVentLead(op)) {
    return { ok: false, message: '越权驳回：只有安全员可以闭环隐患' }
  }
  if (hazard.status === '已闭环') {
    return { ok: true, message: '该隐患已闭环，仍按头一回口径，不重复处理' }
  }
  // 以唯一算法当下结论为准：仍判故障就不允许闭环，防止两边台数对不上。
  const evaluation = getEvaluation(hazard.fanId)
  if (evaluation?.fault) {
    return { ok: false, message: `${hazard.fanCode} 当前仍判定为故障（${evaluation.matchedReason}），隐患不能闭环` }
  }
  const hazards = state.hazards.map((item) =>
    item.id === hazardId ? { ...item, status: '已闭环' as const, closedAt: nowIso() } : item,
  )
  persist({ ...state, hazards })
  return { ok: true, message: '联动隐患已闭环，故障台数两边同步' }
}

export function ensureVentReady(nowIso: string): VentState {
  return bootstrapVent(nowIso)
}
