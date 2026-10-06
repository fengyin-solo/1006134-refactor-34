import assert from 'node:assert'

import {
  VENTILATION_LIMITS,
  collectVentilationHazards,
  evaluateUnit,
  summarizeVentilation,
} from '@/domain/ventilation'
import {
  adjustAirflow,
  listVentilationUnits,
  loadVentilationStopLog,
  loadVentilationSummary,
  runVentilationAction,
} from '@/api/ventilation-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const lead = { name: '测试', role: '通风负责人' }
const admin = { name: '测试', role: '值班管理员' }

// 1. 判定优先级：故障 > 已停机 > 超限 > 登记状态
const faultRow = { id: 1, status: '故障', pending: false, abnormal: true, 有害气体浓度: 0.9, 送风量: 100 } as EntryRow
assert.equal(evaluateUnit(faultRow).status, '故障')
assert.equal(evaluateUnit(faultRow).overLimit, true)

const stoppedRow = { id: 2, status: '已停机', pending: false, abnormal: false, 有害气体浓度: 0.1, 送风量: 500 } as EntryRow
assert.equal(evaluateUnit(stoppedRow).status, '已停机')

const overGas = { id: 3, status: '运行中', pending: true, abnormal: false, 有害气体浓度: 0.8, 送风量: 500 } as EntryRow
assert.equal(evaluateUnit(overGas).status, '已停机', '浓度超限应按停机记')

const overAir = { id: 4, status: '运行中', pending: true, abnormal: false, 有害气体浓度: 0.1, 送风量: 200 } as EntryRow
assert.equal(evaluateUnit(overAir).status, '已停机', '风量不足应按停机记')

const normal = { id: 5, status: '运行中', pending: true, abnormal: false, 有害气体浓度: 0.1, 送风量: 500 } as EntryRow
assert.equal(evaluateUnit(normal).status, '运行中')

// 阈值走同一份配置
const custom = evaluateUnit(overGas, { gasMax: 1.0, airflowMin: 100 })
assert.equal(custom.status, '运行中', '阈值放宽后同一读数应重算为运行中')
assert.equal(VENTILATION_LIMITS.gasMax, 0.5)

// 2. 种子数据汇总：2 号机登记运行中但读数越限 → 按停机记
const summary = loadVentilationSummary()
assert.deepEqual(
  { total: summary.total, running: summary.running, stopped: summary.stopped, fault: summary.fault, overLimit: summary.overLimit, pending: summary.pending },
  { total: 3, running: 0, stopped: 2, fault: 0, overLimit: 1, pending: 1 },
)
const hazards = collectVentilationHazards(listRows('ventilation'))
assert.equal(hazards.length, 1)
assert.equal(hazards[0].机组编号, 'VENT-0002')

// 3. 权限：送风量只允许通风负责人
const denied = adjustAirflow(1, 500, admin)
assert.equal(denied.ok, false)
assert.match(denied.message, /越权/)
const allowed = adjustAirflow(1, 500, lead)
assert.equal(allowed.ok, true)
assert.equal(Number(listRows('ventilation')[0]['送风量']), 500)
// 连着点两回仍按头一回
const again = adjustAirflow(1, 500, lead)
assert.equal(again.ok, true)
assert.match(again.message, /不重复落档/)
// 写不成就别落半条：非法值不改数据
const bad = adjustAirflow(1, Number('abc'), lead)
assert.equal(bad.ok, false)
assert.equal(Number(listRows('ventilation')[0]['送风量']), 500)

// 4. 报修停机（故障）禁止再启动；先登记故障
const faultResult = runVentilationAction(1, '登记故障', lead)
assert.equal(faultResult.ok, true)
const startFault = runVentilationAction(1, '启动机组', lead)
assert.equal(startFault.ok, false)
assert.match(startFault.message, /禁止再启动/)
// 故障登记连着点两回仍按头一回，留档只有一条
const faultAgain = runVentilationAction(1, '登记故障', lead)
assert.equal(faultAgain.ok, true)
assert.match(faultAgain.message, /不重复落档/)
assert.equal(loadVentilationStopLog().length, 1)
// 留档封存当时的口径与版本
const logEntry = loadVentilationStopLog()[0]
assert.equal(logEntry['判定结论'], '故障')
assert.equal(logEntry['规则版本'], 'v1')
assert.equal(logEntry['浓度上限'], 0.5)

// 5. 超限机组禁止启动
const startOverLimit = runVentilationAction(2, '启动机组', lead)
assert.equal(startOverLimit.ok, false)
assert.match(startOverLimit.message, /越限/)

// 6. 停机检修幂等 + 留档
const stop1 = runVentilationAction(2, '停机检修', lead)
assert.equal(stop1.ok, true)
const stop2 = runVentilationAction(2, '停机检修', lead)
assert.equal(stop2.ok, true)
assert.match(stop2.message, /不重复落档/)
assert.equal(loadVentilationStopLog().length, 2)

// 7. 历史数据补登安装位置
const rows = listRows('ventilation')
delete rows[0]['安装位置']
const { saveRows } = await import('@/data/local-store')
saveRows('ventilation', rows)
const units = listVentilationUnits()
assert.equal(units[0].row['安装位置'], '历史补登（安装位置待核）')
assert.equal(String(listRows('ventilation')[0]['安装位置']), '历史补登（安装位置待核）', '补登应一次性写回')

// 8. 汇总与隐患联动同源
const summaryAfter = loadVentilationSummary()
assert.equal(summaryAfter.fault, 1)
assert.ok(loadVentilationStopLog().every((entry) => entry['规则版本'] === 'v1'))

console.log('ventilation sanity checks passed')
