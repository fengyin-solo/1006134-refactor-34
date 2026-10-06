import { defineStore } from 'pinia'

import type { Operator, OperatorRole } from '@/domain/ventilation/types'

/** 演示用可切换身份：服务层按角色+工区强制权限，页面只负责把无权按钮藏起来。 */
export const PRESET_OPERATORS: Operator[] = [
  { name: '赵风', role: '通风负责人', area: '三工区' },
  { name: '钱通', role: '通风负责人', area: '一工区' },
  { name: '李守', role: '值守员', area: '二工区' },
  { name: '陈点', role: '点检员', area: '三工区' },
  { name: '孙安', role: '安全员', area: '一工区' },
]

export const ROLE_LABEL: Record<OperatorRole, string> = {
  通风负责人: '通风负责人（可启动/改送风/报修）',
  值守员: '值守员（可登记、撤销值守停机）',
  点检员: '点检员（可登记读数）',
  安全员: '安全员（可闭环隐患）',
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: PRESET_OPERATORS[2] as Operator,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.name.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(next: Operator) {
      this.operator = next
    },
  },
})
