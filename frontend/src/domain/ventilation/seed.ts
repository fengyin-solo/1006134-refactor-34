import type { StopArchive, VentFan } from './types'

/**
 * 历史机组安装位置台账：老数据只有机组编号、没有安装位置与工区，
 * 迁移时按机组编号查这份台账补登；查不到的列入「安装位置待核实」，不凭空捏造。
 */
export type LedgerEntry = Omit<VentFan, 'id' | 'code' | 'switchOn' | 'repairLock' | 'source'>

export const POSITION_LEDGER: Record<string, LedgerEntry> = {
  VENT_0001: {
    location: '左线 K1+820 一号横通道',
    area: '一工区',
    airflow: 920,
    gas: 0.12,
    temperature: 26.1,
    checkedAt: '2026-08-28',
    keeper: '王伍',
  },
  VENT_0002: {
    location: '左线 K2+100 二号横通道',
    area: '一工区',
    airflow: 860,
    gas: 0.18,
    temperature: 27.0,
    checkedAt: '2026-08-29',
    keeper: '王伍',
  },
  VENT_0003: {
    location: '右线 K2+100 三号横通道',
    area: '二工区',
    airflow: 860,
    gas: 0.1,
    temperature: 27.4,
    checkedAt: '2026-08-30',
    keeper: '李守',
  },
}

/** 台账补登之外、随通风域建立时登记的机组。 */
export type SeedFanInput = Omit<VentFan, 'id' | 'source'>

export const EXTRA_SEED_FANS: SeedFanInput[] = [
  {
    code: 'VENT-0004',
    location: '右线 K2+340 四号横通道',
    area: '二工区',
    airflow: 1050,
    gas: 0.62,
    temperature: 29.2,
    switchOn: true,
    repairLock: false,
    checkedAt: '2026-10-05',
    keeper: '陈点',
    note: '点检浓度超限，看板开关仍在运行位——由唯一算法按故障裁决',
  },
  {
    code: 'VENT-0005',
    location: '左线 K2+560 五号横通道',
    area: '三工区',
    airflow: 0,
    gas: 0.08,
    temperature: 25.3,
    switchOn: false,
    repairLock: true,
    checkedAt: '2026-10-04',
    keeper: '赵风',
    note: '电机异响报修，检修锁定中，禁止启动',
  },
  {
    code: 'VENT-0006',
    location: '右线 K2+560 六号横通道',
    area: '三工区',
    airflow: 640,
    gas: 0.09,
    temperature: 26.0,
    switchOn: true,
    repairLock: false,
    checkedAt: '2026-10-05',
    keeper: '陈点',
    note: '看板开关在运行位，但实测送风量低于下限——由唯一算法按停机裁决',
  },
]

/** 留档种子：fanId 在迁移组装完成后按机组编号回填。 */
export type SeedArchiveInput = Omit<StopArchive, 'id' | 'fanId'> & { fanCode: string }

export const SEED_ARCHIVES: SeedArchiveInput[] = [
  {
    fanCode: 'VENT-0003',
    area: '二工区',
    kind: '值守停机',
    // v1 时期登记：早先的停机记录按当时版本留档，配置升到 v2 后本快照不回改。
    ruleVersion: 1,
    verdictSnapshot: '已停机',
    airflowSnapshot: 860,
    gasSnapshot: 0.1,
    reason: '风筒接口漏风，值守登记停机处理（看板开关仍在运行位）',
    operator: '李守',
    recordedAt: '2026-08-30T22:10:00',
    active: true,
  },
  {
    fanCode: 'VENT-0005',
    area: '三工区',
    kind: '报修检修',
    ruleVersion: 2,
    verdictSnapshot: '故障',
    airflowSnapshot: 0,
    gasSnapshot: 0.08,
    reason: '电机异响报修，停机检修',
    operator: '赵风',
    recordedAt: '2026-10-04T09:30:00',
    active: true,
  },
  {
    fanCode: 'VENT-0001',
    area: '一工区',
    kind: '值守停机',
    ruleVersion: 1,
    verdictSnapshot: '已停机',
    airflowSnapshot: 0,
    gasSnapshot: 0,
    reason: '进场调试期间停机留档（已恢复，记录保留备查）',
    operator: '李守',
    recordedAt: '2026-08-20T16:00:00',
    active: false,
    closedAt: '2026-08-21T08:30:00',
  },
]
