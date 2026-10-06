import { VENT_RULE } from './config'
import type { FanEvaluation, FanVerdict, StopArchive, VentFan, VentRuleConfig } from './types'

/**
 * 通风机组判定算法——全平台仅此一份。
 * 看板（运行状态）、值守汇总（停机台数）、点检入口（浓度判定）都调 evaluateFan / evaluateFans，
 * 不再允许各写一遍。阈值只从 VENT_RULE 取。
 *
 * 纯函数：不读存储、不写存储，同样的（机组、留档、配置）永远得到同样结论。
 * 因此算法/配置一变，所有已登记读数下次读取时自然按新结论重过一遍，无需回写读数。
 */

/** 取该机组当前生效中的留档（同一时刻至多一条生效：检修优先于值守停机）。 */
export function activeArchiveOf(fanId: number, archives: StopArchive[]): StopArchive | undefined {
  const active = archives.filter((item) => item.fanId === fanId && item.active)
  return active.find((item) => item.kind === '报修检修') ?? active[0]
}

export function evaluateFan(
  fan: VentFan,
  archives: StopArchive[],
  rule: VentRuleConfig = VENT_RULE,
): FanEvaluation {
  const activeArchive = activeArchiveOf(fan.id, archives)
  const gasOverLimit = fan.gas >= rule.gasLimitPercent
  const airflowLow = fan.airflow < rule.airflowFloor

  // 裁决顺序与 config.precedence 一一对应，命中即定论。
  let verdict: FanVerdict
  let matchedRule: number
  let matchedReason: string

  if (fan.repairLock || activeArchive?.kind === '报修检修') {
    verdict = '故障'
    matchedRule = 1
    matchedReason = '机组处于报修检修中，禁止启动，按故障计'
  } else if (gasOverLimit) {
    verdict = '故障'
    matchedRule = 2
    matchedReason = `有害气体浓度 ${fan.gas}% 达到上限 ${rule.gasLimitPercent}%，按故障计`
  } else if (activeArchive) {
    verdict = '已停机'
    matchedRule = 3
    matchedReason = `存在生效中的${activeArchive.kind}留档，按停机计，看板运行开关不作数`
  } else if (airflowLow) {
    verdict = '已停机'
    matchedRule = 4
    matchedReason = `实测送风量 ${fan.airflow} 低于下限 ${rule.airflowFloor} m³/min，按停机计`
  } else if (fan.switchOn) {
    verdict = '运行中'
    matchedRule = 5
    matchedReason = '开关在运行位且无更高优先级异常'
  } else {
    verdict = '待启动'
    matchedRule = 6
    matchedReason = '无异常、无停机留档，开关未投入'
  }

  return {
    fan,
    verdict,
    running: verdict === '运行中',
    stopped: verdict === '已停机',
    fault: verdict === '故障',
    gasOverLimit,
    airflowLow,
    activeArchive,
    matchedRule,
    matchedReason,
  }
}

export function evaluateFans(
  fans: VentFan[],
  archives: StopArchive[],
  rule: VentRuleConfig = VENT_RULE,
): FanEvaluation[] {
  return fans.map((fan) => evaluateFan(fan, archives, rule))
}
