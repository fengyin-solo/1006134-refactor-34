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
      <h3>洞内通风（与值守汇总、点检入口同一份判定口径）</h3>
      <div class="stat-row">
        <article v-for="card in ventCards" :key="card.label" class="stat-card">
          <span class="stat-label">{{ card.label }}</span>
          <strong class="stat-value">{{ card.value }}</strong>
        </article>
      </div>
      <p class="vent-limits">
        判定口径：有害气体浓度上限 {{ limits.gasMax }}%、送风量下限 {{ limits.airflowMin }} m³/min，规则版本 v{{ ruleVersion }}
      </p>
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
import { loadVentilationSummary } from '@/api/ventilation-service'
import { VENTILATION_LIMITS, VENTILATION_RULE_VERSION } from '@/domain/ventilation'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const ventCards = ref<{ label: string; value: number }[]>([])
const limits = VENTILATION_LIMITS
const ruleVersion = VENTILATION_RULE_VERSION

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  // 停机台数等通风指标与值守汇总收在同一份，不再各说各话。
  const summary = loadVentilationSummary()
  ventCards.value = [
    { label: '运行机组', value: summary.running },
    { label: '停机机组（含超限）', value: summary.stopped },
    { label: '故障机组', value: summary.fault },
    { label: '有害气体/风量越限', value: summary.overLimit },
  ]
}

onMounted(refresh)
</script>

<style scoped>
.vent-strip {
  margin-bottom: 12px;
}
.vent-strip h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.vent-limits {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 12px;
}
</style>
