<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
// a card that shows only its title until opened
defineProps<{ title: string }>()
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <section class="card">
    <button class="flex items-center justify-between text-left" :aria-expanded="open" @click="open = !open">
      <h2>{{ title }}</h2>
      <span class="text-muted">{{ open ? '▲' : '▼' }}</span>
    </button>
    <slot v-if="open" />
  </section>
</template>
