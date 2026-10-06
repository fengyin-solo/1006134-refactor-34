<template>
  <span class="verdict-tag" :class="klass">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import type { FanVerdict } from '@/domain/ventilation/types'

const props = defineProps<{ verdict: FanVerdict }>()

const text = props.verdict
const klass = computed(() => {
  switch (props.verdict) {
    case '运行中':
      return 'tag-running'
    case '故障':
      return 'tag-fault'
    case '已停机':
      return 'tag-stopped'
    default:
      return 'tag-idle'
  }
})
</script>

<style scoped>
.verdict-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.tag-running { background: #dcfce7; color: #166534; }
.tag-fault { background: #fee2e2; color: #991b1b; }
.tag-stopped { background: #fef3c7; color: #92400e; }
.tag-idle { background: #e2e8f0; color: #475569; }
</style>
