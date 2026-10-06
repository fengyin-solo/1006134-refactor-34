<template>
  <section class="page" data-module="ventilation-inspection">
    <header class="page-head">
      <div>
        <h2>点检入口 · 通风读数登记</h2>
        <p class="page-desc">
          浓度不再单独判一次：点检读数登记后，由通风域唯一算法按浓度上限、送风下限即时重判，三个入口结论一致。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/ventilation">通风看板</RouterLink>
        <RouterLink class="btn" to="/ventilation/watch">值守汇总</RouterLink>
      </div>
    </header>

    <RuleBanner :summary="summary" />

    <div v-if="!canInspect" class="perm-banner">
      当前身份（{{ store.operator.name }} · {{ store.operator.role }}）无权登记点检读数，仅可查看；切换为点检员或通风负责人后可登记。
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>机组编号</th>
          <th>安装位置</th>
          <th>工区</th>
          <th>送风量(m³/min)</th>
          <th>有害气体浓度(%)</th>
          <th>洞内温度(℃)</th>
          <th>最近检测</th>
          <th>唯一算法结论</th>
          <th>登记读数（点检）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.fan.id">
          <td>{{ item.fan.code }}</td>
          <td>{{ item.fan.location }}</td>
          <td>{{ item.fan.area || '待核实' }}</td>
          <td :class="{ 'cell-alarm': item.airflowLow }">{{ item.fan.airflow }}</td>
          <td :class="{ 'cell-alarm': item.gasOverLimit }">{{ item.fan.gas }}</td>
          <td>{{ item.fan.temperature }}</td>
          <td>{{ item.fan.checkedAt }}</td>
          <td><VerdictTag :verdict="item.verdict" /><span class="reason-text">{{ item.matchedReason }}</span></td>
          <td>
            <div v-if="canInspect" class="reading-form">
              <input v-model.number="drafts[item.fan.id].airflow" type="number" placeholder="送风量" />
              <input v-model.number="drafts[item.fan.id].gas" type="number" step="0.01" placeholder="浓度%" />
              <input v-model.number="drafts[item.fan.id].temperature" type="number" step="0.1" placeholder="温度℃" />
              <button class="btn primary small" type="button" @click="submit(item.fan.id)">提交并重判</button>
            </div>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>浓度达到 {{ summary.gasLimitPercent }}% 即由唯一算法判故障并联动安全巡检；算法版本变更后，已登记读数在此页自动按新结论重过。</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import RuleBanner from './components/RuleBanner.vue'
import VerdictTag from './components/VerdictTag.vue'
import { getBoardSummary, getEvaluations, submitReading, type VentBoardSummary } from '@/domain/ventilation/service'
import type { FanEvaluation } from '@/domain/ventilation/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const rows = ref<FanEvaluation[]>([])
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
const message = ref('')
const messageOk = ref(false)

type Draft = { airflow: number | ''; gas: number | ''; temperature: number | '' }
const drafts = reactive<Record<number, Draft>>({})

const canInspect = computed(() => ['点检员', '通风负责人'].includes(store.operator.role))

function ensureDrafts(items: FanEvaluation[]) {
  for (const item of items) {
    if (!drafts[item.fan.id]) {
      drafts[item.fan.id] = { airflow: '', gas: '', temperature: '' }
    }
  }
}

function submit(fanId: number) {
  const draft = drafts[fanId]
  const result = submitReading(fanId, store.operator, {
    airflow: draft.airflow === '' ? undefined : Number(draft.airflow),
    gas: draft.gas === '' ? undefined : Number(draft.gas),
    temperature: draft.temperature === '' ? undefined : Number(draft.temperature),
    checkedAt: new Date().toISOString().slice(0, 10),
  })
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    drafts[fanId] = { airflow: '', gas: '', temperature: '' }
  }
  reload()
}

function reload() {
  rows.value = getEvaluations()
  summary.value = getBoardSummary()
  ensureDrafts(rows.value)
}

onMounted(reload)
</script>

<style scoped>
.cell-alarm { color: #b42318; font-weight: 600; }
.reason-text { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; max-width: 240px; }
.reading-form { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.reading-form input { width: 86px; padding: 4px 6px; }
.btn.small { padding: 4px 8px; font-size: 12px; }
.muted-text { color: var(--muted); }
.perm-banner { background: #fef3c7; border: 1px solid #fde68a; color: #92400e; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px; }
.ok-text { color: #166534; }
.error-text { color: #b42318; }
</style>
