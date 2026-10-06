<template>
  <section class="rule-banner">
    <p class="rule-line">
      唯一算法版本 <strong>v{{ summary.ruleVersion }}</strong>
      ｜有害气体浓度上限 <strong>{{ summary.gasLimitPercent }}%</strong>
      ｜送风量下限 <strong>{{ summary.airflowFloor }} m³/min</strong>
      （阈值集中配置，看板、值守汇总、点检入口同取这一份）
    </p>
    <ol class="rule-precedence">
      <li v-for="text in precedence" :key="text">{{ text }}</li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { VENT_RULE } from '@/domain/ventilation/config'

defineProps<{
  summary: {
    ruleVersion: number
    gasLimitPercent: number
    airflowFloor: number
  }
}>()

const precedence = VENT_RULE.precedence.map((item) => item.replace(/^\d+\.\s*/, ''))
</script>

<style scoped>
.rule-banner {
  background: #fff;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--muted);
}
.rule-line { margin: 0 0 6px; }
.rule-precedence { margin: 0; padding-left: 18px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.rule-precedence li { white-space: nowrap; }
</style>
