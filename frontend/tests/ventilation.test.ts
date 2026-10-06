/**
 * 通风域测试：纯 Node 运行（npm run test:vent）。
 * 用 replaceVentState 直接装载内存状态，绕开 localStorage；覆盖唯一算法、权限、幂等/原子、
 * 配置变更重判、留档冻结、隐患对账、历史补登迁移。
 */
import assert from 'node:assert/strict'

import { VENT_RULE } from '../src/domain/ventilation/config'
import { evaluateFan } from '../src/domain/ventilation/judgment'
import { reconcileHazards, reconcileState } from '../src/domain/ventilation/reconcile'
import {
  closeHazard,
  completeRepair,
  dutyResume,
  dutyStop,
  getArchives,
  getBoardSummary,
  getEvaluations,
  getLinkedHazards,
  startFan,
  stopForRepair,
  submitReading,
  updateAirflow,
} from '../src/domain/ventilation/service'
import { buildInitialState, replaceVentState, resetVentCache } from '../src/domain/ventilation/store'
import type { Operator, VentFan, VentState } from '../src/domain/ventilation/types'

const leads: Record<string, Operator> = {
  a1: { name: '钱通', role: '通风负责人', area: '一工区' },
  a2: { name: '孙通', role: '通风负责人', area: '二工区' },
  a3: { name: '赵风', role: '通风负责人', area: '三工区' },
}
const watch2: Operator = { name: '李守', role: '值守员', area: '二工区' }
const checker3: Operator = { name: '陈点', role: '点检员', area: '三工区' }
const safety: Operator = { name: '孙安', role: '安全员', area: '一工区' }

function baseFan(over: Partial<VentFan>): VentFan {
  return {
    id: 1,
    code: 'T-1',
    location: '左线 K0+001',
    area: '一工区',
    airflow: 1000,
    gas: 0.1,
    temperature: 26,
    switchOn: true,
    repairLock: false,
    checkedAt: '2026-10-05',
    keeper: '陈点',
    source: '正常登记',
    ...over,
  }
}

function stateWith(fans: VentFan[], archives: VentState['archives'] = []): VentState {
  const state: VentState = reconcileState(
    {
      fans,
      archives,
      hazards: [],
      seq: { fan: fans.length, archive: archives.length },
      migrated: true,
    },
    '2026-10-06T00:00:00',
  )
  replaceVentState(state)
  return state
}

let passed = 0
function test(name: string, fn: () => void): void {
  resetVentCache()
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

// 1. 唯一算法裁决顺序 -------------------------------------------------------

test('规则1：报修检修锁定优先，开关在运行位也判故障且禁止启动', () => {
  const fan = baseFan({ repairLock: true, switchOn: true })
  stateWith([fan])
  const ev = getEvaluations()[0]
  assert.equal(ev.verdict, '故障')
  assert.equal(ev.matchedRule, 1)
  const r = startFan(1, leads.a1)
  assert.equal(r.ok, false)
  assert.match(r.message, /禁止启动/)
})

test('规则2：浓度超限判故障，哪怕开关在运行位（看板旧说法被推翻）', () => {
  const ev = evaluateFan(baseFan({ gas: 0.5, switchOn: true }), [])
  assert.equal(ev.verdict, '故障')
  assert.equal(ev.matchedRule, 2)
  assert.equal(ev.gasOverLimit, true)
})

test('规则3：生效中的值守停机留档压过看板运行开关，判停机', () => {
  const fan = baseFan({ switchOn: true, airflow: 1000, gas: 0.1 })
  stateWith([fan], [
    {
      id: 1, fanId: 1, fanCode: 'T-1', area: '一工区', kind: '值守停机',
      ruleVersion: 1, verdictSnapshot: '已停机', airflowSnapshot: 0, gasSnapshot: 0,
      reason: '测试留档', operator: '李守', recordedAt: '2026-10-01T00:00:00', active: true,
    },
  ])
  const ev = getEvaluations()[0]
  assert.equal(ev.verdict, '已停机')
  assert.equal(ev.matchedRule, 3)
})

test('规则4：送风量低于下限判停机，开关不作数', () => {
  const ev = evaluateFan(baseFan({ airflow: 799, switchOn: true }), [])
  assert.equal(ev.verdict, '已停机')
  assert.equal(ev.matchedRule, 4)
})

test('规则5/6：无异常按开关位；停止位判待启动', () => {
  assert.equal(evaluateFan(baseFan({ switchOn: true }), []).verdict, '运行中')
  assert.equal(evaluateFan(baseFan({ switchOn: false }), []).verdict, '待启动')
})

test('裁决优先级：浓度超限优先于值守留档（故障口径压过停机）', () => {
  const fan = baseFan({ gas: 0.6, switchOn: false })
  const ev = evaluateFan(fan, [
    {
      id: 1, fanId: 1, fanCode: 'T-1', area: '一工区', kind: '值守停机',
      ruleVersion: 1, verdictSnapshot: '已停机', airflowSnapshot: 0, gasSnapshot: 0,
      reason: '', operator: '', recordedAt: '2026-10-01T00:00:00', active: true,
    },
  ])
  assert.equal(ev.verdict, '故障')
  assert.equal(ev.matchedRule, 2)
})

// 2. 权限：越权改动直接驳回 -------------------------------------------------

test('非通风负责人不能启动、不能改送风量（驳回且零改动）', () => {
  const fan = baseFan({ switchOn: false })
  stateWith([fan])
  assert.equal(startFan(1, watch2).ok, false)
  assert.equal(startFan(1, checker3).ok, false)
  assert.equal(updateAirflow(1, watch2, 1200).ok, false)
  assert.equal(updateAirflow(1, checker3, 1200).ok, false)
  const after = getEvaluations()[0].fan
  assert.equal(after.switchOn, false)
  assert.equal(after.airflow, 1000)
})

test('外工区通风负责人改本工区送风量/启动：越权驳回', () => {
  stateWith([baseFan({ switchOn: false })])
  assert.equal(startFan(1, leads.a2).ok, false)
  assert.equal(updateAirflow(1, leads.a3, 1200).ok, false)
})

test('本工区通风负责人可启动、可改送风量', () => {
  stateWith([baseFan({ switchOn: false })])
  assert.equal(startFan(1, leads.a1).ok, true)
  assert.equal(updateAirflow(1, leads.a1, 1200).ok, true)
  assert.equal(getEvaluations()[0].fan.airflow, 1200)
})

test('浓度超限或送风不足时，负责人也启动不了', () => {
  stateWith([baseFan({ switchOn: false, gas: 0.5 })])
  assert.equal(startFan(1, leads.a1).ok, false)
  stateWith([baseFan({ switchOn: false, airflow: 500 })])
  assert.equal(startFan(1, leads.a1).ok, false)
})

test('点检员只能登记读数；非法读数整笔驳回', () => {
  stateWith([baseFan({})])
  assert.equal(submitReading(1, watch2, { gas: 0.2, checkedAt: '2026-10-06' }).ok, false)
  const bad = submitReading(1, checker3, { gas: -1, checkedAt: '2026-10-06' })
  assert.equal(bad.ok, false)
  assert.equal(getEvaluations()[0].fan.gas, 0.1)
})

// 3. 幂等与原子 -------------------------------------------------------------

test('连着点两回启动：第二回幂等，不产生留档', () => {
  const state = stateWith([baseFan({ switchOn: false })])
  assert.equal(startFan(1, leads.a1).ok, true)
  const again = startFan(1, leads.a1)
  assert.equal(again.ok, true)
  assert.match(again.message, /无需重复启动/)
  // 启动不写留档
  assert.equal(getArchives().length, 0)
  assert.equal(getBoardSummary().total, 1)
})

test('重复报修登记幂等，不重复追加留档', () => {
  stateWith([baseFan({})])
  assert.equal(stopForRepair(1, leads.a1, '异响').ok, true)
  assert.equal(stopForRepair(1, leads.a1, '异响').ok, true)
  // 报修只产生 1 条留档、1 条待整改隐患
  assert.equal(getArchives().filter((a) => a.active).length, 1)
  const open = getLinkedHazards().filter((h) => h.status === '待整改')
  assert.equal(open.length, 1)
})

test('写失败不落半条：报修原因为空时机组不被锁定', () => {
  stateWith([baseFan({ repairLock: false })])
  const r = stopForRepair(1, leads.a1, '   ')
  assert.equal(r.ok, false)
  assert.equal(getEvaluations()[0].fan.repairLock, false)
})

test('检修完成后锁定解除；再点一次幂等', () => {
  stateWith([baseFan({ repairLock: true, switchOn: false })])
  assert.equal(completeRepair(1, leads.a1).ok, true)
  assert.equal(getEvaluations()[0].fan.repairLock, false)
  assert.equal(completeRepair(1, leads.a1).ok, true)
})

test('值守停机重复登记按头一回事由，不重复追加；撤销后可重判', () => {
  stateWith([baseFan({ switchOn: true })])
  assert.equal(dutyStop(1, watch2, '停机').ok, true)
  assert.equal(getEvaluations()[0].verdict, '已停机')
  assert.equal(dutyStop(1, watch2, '再来一次').ok, true)
  assert.equal(dutyResume(1, watch2).ok, true)
  assert.equal(getEvaluations()[0].verdict, '运行中')
})

// 4. 配置变更：读数重判，留档冻结 -------------------------------------------

test('配置上限调低：同一读数结论由运行变故障（三处共用函数立即生效）', () => {
  const fan = baseFan({ gas: 0.3, switchOn: true })
  assert.equal(evaluateFan(fan, [], VENT_RULE).verdict, '运行中')
  const stricter = { ...VENT_RULE, gasLimitPercent: 0.2 }
  assert.equal(evaluateFan(fan, [], stricter).verdict, '故障')
})

test('算法版本变更只重算读数：v1 留档仍按当时快照保留', () => {
  const fan = baseFan({ switchOn: false, gas: 0.1, airflow: 1000 })
  const state = stateWith([fan], [
    {
      id: 1, fanId: 1, fanCode: 'T-1', area: '一工区', kind: '值守停机',
      ruleVersion: 1, verdictSnapshot: '已停机', airflowSnapshot: 0, gasSnapshot: 0,
      reason: '老版本留档', operator: '李守', recordedAt: '2026-09-01T00:00:00', active: true,
    },
  ])
  // 当前版本（v2）读数仍按现算：留档生效 -> 停机；但留档快照字段不被改写
  assert.equal(getEvaluations()[0].verdict, '已停机')
  const archive = state.archives.find((a) => a.id === 1)!
  assert.equal(archive.ruleVersion, 1)
  assert.equal(archive.verdictSnapshot, '已停机')
})

// 5. 隐患对账：故障机组数两边恒等 -------------------------------------------

test('对账不变式：故障机组数 = 联动待整改隐患数', () => {
  const fans = [
    baseFan({ id: 1, code: 'A', gas: 0.6 }), // 气体故障
    baseFan({ id: 2, code: 'B', repairLock: true, switchOn: false }), // 检修故障
    baseFan({ id: 3, code: 'C', switchOn: true }), // 正常
  ]
  stateWith(fans)
  const faultCount = getEvaluations().filter((e) => e.fault).length
  const openCount = getLinkedHazards().filter((h) => h.status === '待整改').length
  assert.equal(faultCount, 2)
  assert.equal(openCount, faultCount)
})

test('故障解除隐患自动闭环留痕，不删除', () => {
  stateWith([baseFan({ id: 1, gas: 0.6 })])
  assert.equal(getLinkedHazards().filter((h) => h.status === '待整改').length, 1)
  assert.equal(submitReading(1, checker3, { gas: 0.1, checkedAt: '2026-10-06' }).ok, true)
  const hazards = getLinkedHazards()
  assert.equal(hazards.filter((h) => h.status === '待整改').length, 0)
  assert.equal(hazards.filter((h) => h.status === '已闭环').length, 1)
})

test('故障仍成立时安全员不能闭环隐患（防止两边台数对不上）', () => {
  stateWith([baseFan({ id: 1, gas: 0.6 })])
  const id = getLinkedHazards()[0].id
  assert.equal(closeHazard(id, safety).ok, false)
  assert.equal(closeHazard(id, watch2).ok, false)
  submitReading(1, checker3, { gas: 0.1, checkedAt: '2026-10-06' })
  assert.equal(closeHazard(getLinkedHazards()[0].id, safety).ok, true)
})

test('同机组故障来源由气体转为检修：气体隐患闭环、检修隐患立项，条数仍=故障数', () => {
  stateWith([baseFan({ id: 1, gas: 0.6 })])
  assert.equal(getLinkedHazards().filter((h) => h.source === '有害气体超限' && h.status === '待整改').length, 1)
  stopForRepair(1, leads.a1, '电机故障')
  const open = getLinkedHazards().filter((h) => h.status === '待整改')
  assert.equal(open.length, 1)
  assert.equal(open[0].source, '报修检修')
  assert.equal(getLinkedHazards().filter((h) => h.source === '有害气体超限' && h.status === '已闭环').length, 1)
})

test('reconcileHazards 对同一状态再跑一遍结果稳定（确定性）', () => {
  const fans = [baseFan({ id: 1, gas: 0.6 }), baseFan({ id: 2, code: 'T-2', switchOn: false })]
  const first = reconcileHazards(fans, [], [], '2026-10-06T00:00:00')
  const second = reconcileHazards(fans, [], first, '2026-10-06T01:00:00')
  assert.deepEqual(second.map((h) => [h.id, h.status]), first.map((h) => [h.id, h.status]))
})

// 6. 历史机组按安装位置补登 -------------------------------------------------

test('迁移：旧台账通风机组按编号查位置台账补登，迁移后 6 台、补登 3 台', () => {
  const legacy = [
    { id: 1, status: '待启动', pending: true, abnormal: false, '机组编号': 'VENT-0001', '检测日期': '2026-09-01' },
    { id: 2, status: '运行中', pending: true, abnormal: true, '机组编号': 'VENT_0002', '检测日期': '2026-09-02' },
    { id: 3, status: '已停机', pending: false, abnormal: false, '机组编号': 'VENT-0003', '检测日期': '2026-09-03' },
  ]
  const state = buildInitialState(legacy, '2026-10-06T00:00:00')
  assert.equal(state.fans.length, 6)
  assert.equal(state.fans.filter((f) => f.source === '历史补登').length, 3)
  const f1 = state.fans.find((f) => f.code === 'VENT-0001')!
  assert.equal(f1.location, '左线 K1+820 一号横通道')
  assert.equal(f1.area, '一工区')
  assert.equal(f1.airflow, 920)
  // 连字符/下划线两种编号写法都能命中台账
  const f2 = state.fans.find((f) => f.code === 'VENT_0002')!
  assert.equal(f2.location, '左线 K2+100 二号横通道')
  // 旧台账「运行中」与值守留档冲突：唯一算法按留档判停机
  replaceVentState(state)
  const f3ev = getEvaluations().find((e) => e.fan.code === 'VENT-0003')!
  assert.equal(f3ev.verdict, '已停机')
  assert.equal(f3ev.matchedRule, 3)
  // 迁移后首启状态即对账完成：故障机组数 == 待整改隐患数
  const faults = getEvaluations().filter((e) => e.fault).length
  const open = getLinkedHazards().filter((h) => h.status === '待整改').length
  assert.equal(faults, open)
})

test('迁移：台账查不到的历史机组不捏造位置，标记待核实', () => {
  const state = buildInitialState(
    [{ id: 9, status: '待启动', pending: true, abnormal: false, '机组编号': 'VENT-9999' }],
    '2026-10-06T00:00:00',
  )
  const fan = state.fans.find((f) => f.code === 'VENT-9999')!
  assert.equal(fan.location, '安装位置待核实')
  assert.equal(fan.area, '')
})

test('种子场景：同一机组三处旧说法打架（VENT-0004 开关运行但浓度超限）统一判故障', () => {
  const state = buildInitialState([], '2026-10-06T00:00:00')
  replaceVentState(state)
  const v4 = getEvaluations().find((e) => e.fan.code === 'VENT-0004')!
  assert.equal(v4.fan.switchOn, true) // 看板会说运行
  assert.equal(v4.verdict, '故障') // 唯一算法说故障
  const v6 = getEvaluations().find((e) => e.fan.code === 'VENT-0006')!
  assert.equal(v6.verdict, '已停机') // 开关运行但送风不足 -> 停机
})

console.log(`\n通风域测试全部通过：${passed} 项`)
