<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()

const items = [
  { name: 'tab', label: 'nav.tab', icon: 'tab', match: ['tab'] },
  { name: 'chat', label: 'nav.chat', icon: 'chat', match: ['chat'] },
  { name: 'group', label: 'nav.group', icon: 'group', match: ['group', 'join'] },
  { name: 'profile', label: 'nav.profile', icon: 'profile', match: ['profile'] },
] as const

function isActive(item: (typeof items)[number]): boolean {
  return (item.match as readonly string[]).includes(String(route.name))
}
</script>

<template>
  <nav class="shrink-0 border-t border-border bg-surface pb-3">
    <div class="mx-auto grid max-w-md grid-cols-4">
      <RouterLink
        v-for="item in items"
        :key="item.name"
        :to="{ name: item.name }"
        class="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors"
        :class="isActive(item) ? 'text-primary' : 'text-muted'"
      >
        <svg v-if="item.icon === 'tab'" class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10 2.5h4M10.75 2.5v4c0 1.25-3.25 2.5-3.25 5V20a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5v-8.5c0-2.5-3.25-3.75-3.25-5v-4M7.5 12.5h9M7.5 17h9" />
        </svg>
        <svg v-else-if="item.icon === 'chat'" class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v11H9l-5 4V5Z" />
        </svg>
        <svg v-else-if="item.icon === 'group'" class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2 20c0-3 3.1-5.5 7-5.5s7 2.5 7 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c2.1.7 3.5 2.7 3.5 5.2" />
        </svg>
        <svg v-else class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.76 10.19L21.38 10.51L21.38 13.49L18.76 13.81L18.06 15.5L19.69 17.58L17.58 19.69L15.5 18.06L13.81 18.76L13.49 21.38L10.51 21.38L10.19 18.76L8.5 18.06L6.42 19.69L4.31 17.58L5.94 15.5L5.24 13.81L2.62 13.49L2.62 10.51L5.24 10.19L5.94 8.5L4.31 6.42L6.42 4.31L8.5 5.94L10.19 5.24L10.51 2.62L13.49 2.62L13.81 5.24L15.5 5.94L17.58 4.31L19.69 6.42L18.06 8.5ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        </svg>
        <span>{{ t(item.label) }}</span>

      </RouterLink>
    </div>
  </nav>
</template>
