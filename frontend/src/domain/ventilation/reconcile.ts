import { evaluateFans } from './judgment'
import type { StopArchive, VentFan, VentHazard, VentState } from './types'

/**
 * 通风故障 ↔ 安全巡检隐患清单对账（纯函数，每次写操作后随整份状态一起落盘）。
 *
 * 不变式：任意时刻「通风判定为故障的机组数」≡「联动隐患中状态为待整改的条数」。
 * 安全巡检页与看板都只数同一份 hazards，故障机组数不可能各说各话。
 * 隐患按 机组+来源 维持身份：故障解除即闭环留痕；同一机组故障来源变化，旧的闭环、新的立项。
 */
export function reconcileHazards(
  fans: VentFan[],
  archives: StopArchive[],
  previous: VentHazard[],
  nowIso: string,
): VentHazard[] {
  const evaluations = evaluateFans(fans, archives)
  const next: VentHazard[] = []

  for (const item of evaluations) {
    if (!item.fault) {
      continue
    }
    const source =
      item.fan.repairLock || item.activeArchive?.kind === '报修检修'
        ? ('报修检修' as const)
        : ('有害气体超限' as const)
    const id = `VENT-H-${item.fan.id}-${source === '报修检修' ? 'REPAIR' : 'GAS'}`
    const existing = previous.find((hazard) => hazard.id === id)
    next.push({
      id,
      fanId: item.fan.id,
      fanCode: item.fan.code,
      area: item.fan.area,
      location: item.fan.location,
      title:
        source === '有害气体超限'
          ? `通风机组 ${item.fan.code} 有害气体浓度超限（${item.fan.gas}%）`
          : `通风机组 ${item.fan.code} 报修检修中，禁止启动`,
      level: source === '有害气体超限' ? '重大' : '一般',
      source,
      openedAt: existing?.openedAt ?? nowIso,
      status: '待整改',
      closedAt: undefined,
    })
  }

  // 已不成立的旧隐患（含同机组来源切换后作废的那一条）：闭环留痕，不删除。
  const liveIds = new Set(next.map((hazard) => hazard.id))
  for (const hazard of previous) {
    if (liveIds.has(hazard.id)) {
      continue
    }
    next.push({ ...hazard, status: '已闭环', closedAt: hazard.closedAt ?? nowIso })
  }

  return next
}

export function reconcileState(state: VentState, nowIso: string): VentState {
  return { ...state, hazards: reconcileHazards(state.fans, state.archives, state.hazards, nowIso) }
}
