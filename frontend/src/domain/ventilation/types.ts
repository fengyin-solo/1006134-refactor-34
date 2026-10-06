/** 通风域公共类型：看板、值守汇总、点检入口、安全巡检联动统一使用，禁止各页另立结构。 */

/** 机组的工况：三个入口最终都只承认这一种结论。 */
export type FanVerdict = '运行中' | '已停机' | '待启动' | '故障'

/** 停机留档的性质：值守登记的是普通停机，检修登记的会锁定机组禁止启动。 */
export type StopKind = '值守停机' | '报修检修'

/** 系统角色：权限判定全部基于角色 + 工区，服务层强制，页面只负责隐藏按钮。 */
export type OperatorRole = '通风负责人' | '值守员' | '点检员' | '安全员'

export type Operator = {
  name: string
  role: OperatorRole
  /** 本工区编码；通风负责人只能改本工区的送风量、启动本工区机组。 */
  area: string
}

/**
 * 通风机组（已登记读数）。
 * 读数本身不存结论：结论由算法按当前配置版本现算，配置一变，所有读数自动重判。
 */
export type VentFan = {
  id: number
  code: string
  /** 安装位置，如「左线 K2+100 一号横通道」。历史机组按位置台账补登。 */
  location: string
  /** 所属工区，决定谁能改送风量、谁能启动。 */
  area: string
  /** 实测送风量，单位 m³/min。 */
  airflow: number
  /** 有害气体浓度，单位 %（占空气体积比），上限取唯一配置。 */
  gas: number
  /** 洞内温度，单位 ℃。 */
  temperature: number
  /** 机组开关位：看板过去只认这一位，现仅作为最低优先级输入。 */
  switchOn: boolean
  /** 报修检修锁定：置位期间禁止再启动，直到检修完成。 */
  repairLock: boolean
  /** 最新检测日期。 */
  checkedAt: string
  /** 值守/点检人员。 */
  keeper: string
  /** 数据来源：正常登记 / 按安装位置补登的历史机组。 */
  source: '正常登记' | '历史补登'
  note?: string
}

/** 停机留档：只追加、不改写；早先记录按当时版本留档。 */
export type StopArchive = {
  id: number
  fanId: number
  fanCode: string
  area: string
  kind: StopKind
  /** 写入留档时的算法版本，快照冻结，不随后续算法变更改动。 */
  ruleVersion: number
  /** 写入时的判定结论快照。 */
  verdictSnapshot: FanVerdict
  /** 写入时的关键读数快照。 */
  airflowSnapshot: number
  gasSnapshot: number
  reason: string
  operator: string
  recordedAt: string
  /** 生效中为 true；恢复/检修完成后关闭，记录本身保留。 */
  active: boolean
  closedAt?: string
}

/** 算法给出的单台机组判定结论（含命中的规则，便于三个入口展示同一份依据）。 */
export type FanEvaluation = {
  fan: VentFan
  verdict: FanVerdict
  running: boolean
  stopped: boolean
  fault: boolean
  gasOverLimit: boolean
  airflowLow: boolean
  /** 当前生效中的留档（可能为值守停机或报修检修）。 */
  activeArchive?: StopArchive
  /** 命中规则的优先级序号，1 最高；三个入口展示同一段口径。 */
  matchedRule: number
  matchedReason: string
}

/**
 * 唯一配置：浓度上限、送风量下限集中在此，看板与汇总都从这里取数。
 * ruleVersion 变化即代表算法调整：所有已登记读数按新结论重过一遍（结论现算，无需迁移），
 * 已写入的停机留档仍按其 ruleVersion 快照留档。
 */
export type VentRuleConfig = {
  ruleVersion: number
  /** 有害气体浓度上限（%），达到或超过即判故障并联动安全隐患。 */
  gasLimitPercent: number
  /** 送风量下限（m³/min），低于即判停机，不采信运行开关。 */
  airflowFloor: number
  /** 优先级口径，顺序即裁决顺序，供页面统一展示。 */
  precedence: string[]
}

/** 联动到安全巡检隐患清单的隐患条目：故障机组数两边只数这一份。 */
export type VentHazard = {
  id: string
  fanId: number
  fanCode: string
  area: string
  location: string
  title: string
  level: '重大' | '一般'
  source: '有害气体超限' | '报修检修'
  openedAt: string
  /** open 计入故障/隐患数；闭环后保留记录，不再计数。 */
  status: '待整改' | '已闭环'
  closedAt?: string
}

/** 通风域完整状态：一次写操作生成整份新状态后整体落盘，不留半成品。 */
export type VentState = {
  fans: VentFan[]
  archives: StopArchive[]
  hazards: VentHazard[]
  seq: { fan: number; archive: number }
  /** 存储结构版本，用于历史数据补登迁移，只跑一次。 */
  migrated: boolean
}

/** 服务层写操作统一返回：ok=false 即驳回，状态零改动。 */
export type VentResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}
