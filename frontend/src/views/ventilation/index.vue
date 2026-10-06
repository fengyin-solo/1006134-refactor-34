<template>
  <section class="page" data-module="ventilation-board">
    <header class="page-head">
      <div>
        <h2>通风机组运行看板</h2>
        <p class="page-desc">
          运行结论由通风域唯一算法给出：报修锁定、浓度超限、值守留档、送风下限依次裁决，看板开关只是最低优先级输入。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/ventilation/watch">值守汇总</RouterLink>
        <RouterLink class="btn" to="/ventilation/inspection">点检入口</RouterLink>
        <RouterLink class="btn" to="/safety?hazard=vent">安全巡检隐患</RouterLink>
      </div>
    </header>

    <RuleBanner :summary="summary" />

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.klass">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>机组编号 / 安装位置</span>
        <input v-model="keyword" placeholder="按编号或安装位置检索" />
      </label>
      <label class="filter-item">
        <span>工区</span>
        <select v-model="areaFilter">
          <option value="">全部工区</option>
          <option v-for="area in areas" :key="area" :value="area">{{ area }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>机组编号</th>
          <th>安装位置</th>
          <th>工区</th>
          <th>送风量(m³/min)</th>
          <th>有害气体浓度(%)</th>
          <th>洞内温度(℃)</th>
          <th>开关位</th>
          <th>算法结论</th>
          <th>裁决依据</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filtered" :key="item.fan.id">
          <td>{{ item.fan.code }}<span v-if="item.fan.source === '历史补登'" class="src-tag">历史补登</span></td>
          <td>{{ item.fan.location }}</td>
          <td>{{ item.fan.area || '待核实' }}</td>
          <td :class="{ 'cell-alarm': item.airflowLow }">{{ item.fan.airflow }}</td>
          <td :class="{ 'cell-alarm': item.gasOverLimit }">{{ item.fan.gas }}</td>
          <td>{{ item.fan.temperature }}</td>
          <td>{{ item.fan.switchOn ? '运行位' : '停止位' }}</td>
          <td><VerdictTag :verdict="item.verdict" /></td>
          <td class="reason-cell">{{ item.matchedReason }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(item)"
              :key="action.key"
              class="link"
              type="button"
              @click="runAction(action.key, item.fan.id)"
            >
              {{ action.label }}
            </button>
            <span v-if="availableActions(item).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!filtered.length">
          <td colspan="10" class="empty-state">暂无符合条件的通风机组</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filtered.length }} / {{ summary.total }} 台机组；故障台数与安全巡检联动隐患数一致（{{ summary.fault }}）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import RuleBanner from './components/RuleBanner.vue'
import VerdictTag from './components/VerdictTag.vue'
import {
  completeRepair,
  dutyResume,
  dutyStop,
  getBoardSummary,
  getEvaluations,
  startFan,
  stopForRepair,
  updateAirflow,
  type VentBoardSummary,
} from '@/domain/ventilation/service'
import type { FanEvaluation } from '@/domain/ventilation/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const route = useRoute()
const router = useRouter()

const evaluations = ref<FanEvaluation[]>([])
const summary = ref<VentBoardSummary>({
  total: 0,
  running: 0,
  stopped: 0,
  fault: 0,
  gasOverLimit: 0,
  ruleVersion: 2,
  gasLimitPercent: 0.5,
  airflowFloor: 800,
})
const focusId = Number(route.query.focus ?? 0)
const focusFan = focusId ? getEvaluations().find((item) => item.fan.id === focusId) : undefined
const keyword = ref(focusFan ? focusFan.fan.code : '')
const areaFilter = ref(focusFan ? focusFan.fan.area : '')
const message = ref('')
const messageOk = ref(false)

const statsCards = computed(() => [
  { label: '机组总数', value: summary.value.total, klass: '' },
  { label: '运行机组', value: summary.value.running, klass: 'ok-text' },
  { label: '停机台数（与值守汇总同一份）', value: summary.value.stopped, klass: 'warn-text' },
  { label: '故障机组（＝巡检联动隐患）', value: summary.value.fault, klass: 'error-text' },
  { label: '有害气体超限', value: summary.value.gasOverLimit, klass: 'error-text' },
])

const areas = computed(() => [...new Set(evaluations.value.map((item) => item.fan.area).filter(Boolean))])

const filtered = computed(() =>
  evaluations.value.filter((item) => {
    const hitKeyword =
      keyword.value.trim() === '' ||
      item.fan.code.includes(keyword.value.trim()) ||
      item.fan.location.includes(keyword.value.trim())
    const hitArea = areaFilter.value === '' || item.fan.area === areaFilter.value
    return hitKeyword && hitArea
  }),
)

type ActionKey = 'start' | 'repair' | 'repairDone' | 'dutyStop' | 'dutyResume' | 'airflow'

function availableActions(item: FanEvaluation): { key: ActionKey; label: string }[] {
  const op = store.operator
  const actions: { key: ActionKey; label: string }[] = []
  if (op.role === '通风负责人' && op.area === item.fan.area) {
    if (!item.fan.repairLock) {
      actions.push({ key: 'start', label: item.fan.switchOn ? '启动（重试点）' : '启动机组' })
      actions.push({ key: 'repair', label: '停机检修' })
    } else {
      actions.push({ key: 'repairDone', label: '检修完成' })
    }
    actions.push({ key: 'airflow', label: '调整送风量' })
  }
  if (op.role === '值守员' || op.role === '通风负责人') {
    if (item.activeArchive?.kind === '值守停机') {
      actions.push({ key: 'dutyResume', label: '撤销停机' })
    } else if (!item.fan.repairLock && !item.activeArchive) {
      actions.push({ key: 'dutyStop', label: '值守停机' })
    }
  }
  return actions
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function runAction(action: ActionKey, fanId: number) {
  const op = store.operator
  let result
  if (action === 'start') {
    result = startFan(fanId, op)
  } else if (action === 'repair') {
    const reason = window.prompt('报修停机原因（写入留档，按当时算法版本快照保留）')
    if (reason === null) {
      return
    }
    result = stopForRepair(fanId, op, reason)
  } else if (action === 'repairDone') {
    result = completeRepair(fanId, op)
  } else if (action === 'dutyStop') {
    const reason = window.prompt('值守停机原因')
    if (reason === null) {
      return
    }
    result = dutyStop(fanId, op, reason)
  } else if (action === 'dutyResume') {
    result = dutyResume(fanId, op)
  } else {
    const raw = window.prompt('调整后送风量（m³/min），仅本工区通风负责人可改')
    if (raw === null) {
      return
    }
    const value = Number(raw)
    result = updateAirflow(fanId, op, value)
  }
  notify(result.ok, result.message)
  reload()
}

function resetFilters() {
  keyword.value = ''
  areaFilter.value = ''
  if (route.query.focus) {
    router.replace({ path: '/ventilation' })
  }
}

function reload() {
  evaluations.value = getEvaluations()
  summary.value = getBoardSummary()
}

onMounted(reload)
store.$subscribe(() => reload())
</script>

<style scoped>
.cell-alarm { color: #b42318; font-weight: 600; }
.reason-cell { color: var(--muted); font-size: 12px; max-width: 260px; }
.src-tag { display: inline-block; margin-left: 6px; background: #e0e7ff; color: #3730a3; border-radius: 4px; padding: 0 6px; font-size: 11px; }
.muted-text { color: var(--muted); }
.ok-text { color: #166534; }
.warn-text { color: #92400e; }
.error-text { color: #b42318; }
</style>
