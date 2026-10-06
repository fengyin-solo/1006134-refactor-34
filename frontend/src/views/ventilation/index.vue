<template>
  <section class="page" data-module="ventilation">
    <header class="page-head">
      <div>
        <h2>洞内通风管理</h2>
        <p class="page-desc">
          维护通风机组，围绕机组编号、安装位置、风筒长度、送风量做登记、筛选与状态流转。
          判定口径全站一份：有害气体浓度上限 {{ limits.gasMax }}%、送风量下限 {{ limits.airflowMin }} m³/min。
        </p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          当前角色
          <select v-model="role">
            <option value="值班管理员">值班管理员</option>
            <option value="通风负责人">通风负责人</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记通风机组</button>
        <button class="btn" type="button" @click="exportRows">导出洞内通风清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>登记状态</th>
          <th>生效结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="unit in units" :key="String(unit.row.id)">
          <td v-for="column in columns" :key="column">{{ unit.row[column] ?? '—' }}</td>
          <td>{{ unit.row.status }}</td>
          <td>
            <strong :class="{ 'error-text': unit.verdict.status !== unit.row.status }">
              {{ unit.verdict.status }}<template v-if="unit.verdict.overLimit">（超限）</template>
            </strong>
            <div class="verdict-reasons">{{ unit.verdict.reasons.join('；') }}</div>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, unit.row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!units.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无洞内通风数据，可先登记通风机组</td>
        </tr>
      </tbody>
    </table>

    <section v-if="stopLog.length" class="stop-log">
      <h3>停机留档（按当时口径封存，不随算法调整回改）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in stopLogColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in stopLog" :key="String(entry.id)">
            <td v-for="column in stopLogColumns" :key="column">{{ entry[column] ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ units.length }} 条洞内通风记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, filterRows, moduleMeta } from '@/api/local-service'
import {
  VENTILATION_LEAD_ROLE,
  adjustAirflow,
  listVentilationUnits,
  loadVentilationStopLog,
  runVentilationAction,
} from '@/api/ventilation-service'
import { VENTILATION_LIMITS, summarizeVentilation } from '@/domain/ventilation'
import type { VentilationUnit } from '@/api/ventilation-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('ventilation')
const columns = meta.fields
const actions = ["启动机组", "停机检修", "登记故障", "调整送风量"]
const statuses = meta.statuses
const limits = VENTILATION_LIMITS
const stopLogColumns = ["登记时间", "机组编号", "安装位置", "操作", "判定结论", "判定依据", "规则版本", "操作人"]

const session = useSessionStore()
const role = computed({
  get: () => session.role,
  set: (value: string) => session.setRole(value),
})

const allUnits = ref<VentilationUnit[]>([])
const stopLog = ref<EntryRow[]>([])
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const units = computed(() => {
  const matched = filterRows(allUnits.value.map((unit) => unit.row), filters.value)
  const ids = new Set(matched.map((row) => Number(row.id)))
  return allUnits.value.filter((unit) => ids.has(Number(unit.row.id)))
})

// 值守汇总：与看板、点检入口读同一份判定口径。
const summary = computed(() => summarizeVentilation(allUnits.value.map((unit) => unit.row)))
const stats = computed(() => [
  { label: '运行机组', value: summary.value.running },
  { label: '停机机组（含超限）', value: summary.value.stopped },
  { label: '故障机组', value: summary.value.fault },
  { label: '有害气体/风量越限', value: summary.value.overLimit },
])

// 状态分布按生效结论记，不按登记状态记。
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allUnits.value.filter((unit) => unit.verdict.status === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '通风机组登记入口尚未接入审批流'
}

function operator() {
  return { name: session.operator, role: session.role }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '调整送风量') {
    const input = window.prompt(
      `请输入新的送风量（m³/min），仅本工区${VENTILATION_LEAD_ROLE}可改动`,
      String(row['送风量'] ?? ''),
    )
    if (input === null) {
      return
    }
    const result = adjustAirflow(Number(row.id), Number(input), operator())
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
    return
  }
  const result = runVentilationAction(Number(row.id), action, operator())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    allUnits.value = listVentilationUnits()
    stopLog.value = loadVentilationStopLog()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '洞内通风列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.role-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.verdict-reasons {
  font-size: 12px;
  color: var(--muted);
}
.stop-log {
  margin-top: 16px;
}
.stop-log h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.notice-text {
  color: #067647;
}
</style>
