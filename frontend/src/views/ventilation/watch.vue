<template>
  <section class="page" data-module="ventilation-watch">
    <header class="page-head">
      <div>
        <h2>值守汇总 · 通风机组停机台数</h2>
        <p class="page-desc">
          停机台数直接取唯一算法的现算结论，与通风看板同一份；停机留档只追加，早先记录按写入时的算法版本留档。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/ventilation">通风看板</RouterLink>
        <RouterLink class="btn" to="/ventilation/inspection">点检入口</RouterLink>
      </div>
    </header>

    <RuleBanner :summary="summary" />

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">停机台数（与看板一致）</span>
        <strong class="stat-value warn-text">{{ summary.stopped }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">其中：值守停机留档生效</span>
        <strong class="stat-value">{{ dutyStopped }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">其中：送风低于下限</span>
        <strong class="stat-value">{{ airflowLowCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">报修检修（故障）</span>
        <strong class="stat-value error-text">{{ summary.fault }}</strong>
      </article>
    </div>

    <h3 class="block-title">当前停机机组（唯一算法结论）</h3>
    <table class="data-table">
      <thead>
        <tr><th>机组编号</th><th>安装位置</th><th>工区</th><th>算法结论</th><th>裁决依据</th><th>留档状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in stoppedRows" :key="item.fan.id">
          <td>{{ item.fan.code }}</td>
          <td>{{ item.fan.location }}</td>
          <td>{{ item.fan.area || '待核实' }}</td>
          <td><VerdictTag :verdict="item.verdict" /></td>
          <td class="reason-cell">{{ item.matchedReason }}</td>
          <td>{{ item.activeArchive ? `${item.activeArchive.kind}（v${item.activeArchive.ruleVersion}）` : '无留档' }}</td>
          <td class="row-actions">
            <button
              v-if="canDuty && (!item.activeArchive || item.activeArchive.kind === '值守停机')"
              class="link"
              type="button"
              @click="toggleDuty(item)"
            >
              {{ item.activeArchive?.kind === '值守停机' ? '撤销停机' : '登记值守停机' }}
            </button>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!stoppedRows.length">
          <td colspan="7" class="empty-state">当前无判定停机的机组</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">停机留档（只追加；早先记录按当时版本留档，不随算法变更回改）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>留档时间</th><th>机组编号</th><th>类型</th><th>算法版本</th>
          <th>当时结论快照</th><th>当时送风量/浓度</th><th>事由</th><th>登记人</th><th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="archive in archives" :key="archive.id" :class="{ 'row-closed': !archive.active }">
          <td>{{ formatTime(archive.recordedAt) }}</td>
          <td>{{ archive.fanCode }}</td>
          <td>{{ archive.kind }}</td>
          <td>
            v{{ archive.ruleVersion }}
            <span v-if="archive.ruleVersion !== summary.ruleVersion" class="version-tag">
              当前 v{{ summary.ruleVersion }}，本条按 v{{ archive.ruleVersion }} 留档
            </span>
          </td>
          <td>{{ archive.verdictSnapshot }}</td>
          <td>{{ archive.airflowSnapshot }} / {{ archive.gasSnapshot }}%</td>
          <td class="reason-cell">{{ archive.reason }}</td>
          <td>{{ archive.operator }}</td>
          <td>{{ archive.active ? '生效中' : `已关闭${archive.closedAt ? ' · ' + formatTime(archive.closedAt) : ''}` }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>另一入口（通风看板）读到的停机台数同为 {{ summary.stopped }}，两边收在一份取数</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import RuleBanner from './components/RuleBanner.vue'
import VerdictTag from './components/VerdictTag.vue'
import {
  dutyResume,
  dutyStop,
  getArchives,
  getBoardSummary,
  getEvaluations,
  type VentBoardSummary,
} from '@/domain/ventilation/service'
import type { FanEvaluation, StopArchive } from '@/domain/ventilation/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const evaluations = ref<FanEvaluation[]>([])
const archives = ref<StopArchive[]>([])
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

const canDuty = computed(() => store.operator.role === '值守员' || store.operator.role === '通风负责人')
const stoppedRows = computed(() => evaluations.value.filter((item) => item.stopped))
const dutyStopped = computed(
  () => stoppedRows.value.filter((item) => item.activeArchive?.kind === '值守停机').length,
)
const airflowLowCount = computed(
  () => stoppedRows.value.filter((item) => !item.activeArchive && item.airflowLow).length,
)

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}

function toggleDuty(item: FanEvaluation) {
  const op = store.operator
  if (item.activeArchive?.kind === '值守停机') {
    const result = dutyResume(item.fan.id, op)
    messageOk.value = result.ok
    message.value = result.message
  } else {
    const reason = window.prompt('值守停机原因')
    if (reason === null) {
      return
    }
    const result = dutyStop(item.fan.id, op, reason)
    messageOk.value = result.ok
    message.value = result.message
  }
  reload()
}

function reload() {
  evaluations.value = getEvaluations()
  archives.value = getArchives()
  summary.value = getBoardSummary()
}

onMounted(reload)
store.$subscribe(() => reload())
</script>

<style scoped>
.block-title { font-size: 14px; margin: 18px 0 8px; }
.reason-cell { color: var(--muted); font-size: 12px; max-width: 240px; }
.muted-text { color: var(--muted); }
.row-closed { color: var(--muted); }
.version-tag { margin-left: 6px; background: #fef3c7; color: #92400e; border-radius: 4px; padding: 0 6px; font-size: 11px; }
.ok-text { color: #166534; }
.warn-text { color: #92400e; }
.error-text { color: #b42318; }
</style>
