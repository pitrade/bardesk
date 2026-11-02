<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'

// page heading of Tab, Chat and Group: the active group and who of it is online
const { t } = useI18n()
const tap = useTap()

const group = computed(() => tap.group(tap.view.activeGroupId))
</script>

<template>
  <div v-if="group" class="flex items-center justify-between gap-3">
    <h1 class="truncate">{{ group.name }}</h1>
    <span class="badge" :class="group.online.length ? 'badge-positive' : ''">
      {{ group.online.length ? t('tab.online', { n: group.online.length }) : t('tab.offline') }}
    </span>
  </div>
</template>
