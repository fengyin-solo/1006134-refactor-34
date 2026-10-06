<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <section class="vent-strip">
      <div class="vent-strip-head">
        <strong>通风机组（唯一算法 v{{ ventSummary.ruleVersion }}，浓度上限 {{ ventSummary.gasLimitPercent }}% / 送风下限 {{ ventSummary.airflowFloor }}）</strong>
        <RouterLink class="btn small" to="/ventilation">进入通风看板</RouterLink>
      </div>
      <span>总数 {{ ventSummary.total }}</span>
      <span class="ok">运行 {{ ventSummary.running }}</span>
      <span class="warn">停机 {{ ventSummary.stopped }}</span>
      <span class="bad">故障 {{ ventSummary.fault }}（＝安全巡检联动隐患 {{ ventSummary.fault }} 条）</span>
    </section>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { ensureVentReady, getBoardSummary, type VentBoardSummary } from '@/domain/ventilation/service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const ventSummary = ref<VentBoardSummary>({
  total: 0,
  running: 0,
  stopped: 0,
  fault: 0,
  gasOverLimit: 0,
  ruleVersion: 2,
  gasLimitPercent: 0.5,
  airflowFloor: 800,
})

function refresh() {
  ensureVentReady(new Date().toISOString())
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  ventSummary.value = getBoardSummary()
}

onMounted(refresh)
</script>

<style scoped>
.vent-strip { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; gap: 18px; align-items: center; font-size: 13px; }
.vent-strip-head { display: flex; align-items: center; gap: 10px; margin-right: 8px; }
.vent-strip .ok { color: #166534; }
.vent-strip .warn { color: #92400e; }
.vent-strip .bad { color: #b42318; }
.btn.small { padding: 3px 8px; font-size: 12px; }
</style>
