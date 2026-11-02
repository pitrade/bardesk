<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTap } from './stores/tap'
import { brand } from './brand'
import BottomNav from './components/BottomNav.vue'
import { displayVersion, takeUpdateNote, updateApp } from './utils/update'

const NOTICE_MS = 5000

const route = useRoute()
const router = useRouter()
const tap = useTap()
const { t } = useI18n()

const notice = computed(() => tap.view.notice)

// each page starts at the top (pages share the shell's scrolling content area)
const content = useTemplateRef<HTMLElement>('content')
watch(
  () => route.path,
  () => content.value?.scrollTo(0, 0),
)

// logged out elsewhere (new device) or account deleted: back to the login screen
watch(
  () => tap.view.email,
  (email) => {
    if (!email && !route.meta.public) router.push({ name: 'login' })
  },
)

// "Updated to …" once after an update, hides by itself
const updatedTo = ref(takeUpdateNote())
if (updatedTo.value) setTimeout(() => (updatedTo.value = null), NOTICE_MS)

// the server names another database than this device uses: it keeps its own (utils/dbName.ts)
const keptDb = ref(tap.dbName !== brand.dbName)
if (keptDb.value) setTimeout(() => (keptDb.value = false), NOTICE_MS)

// another app version is deployed: update right away, then sync again
const updateStuck = ref(false)

/** Notices that need a tap keep their button; all others hide after a few seconds. */
const needsAction = computed(
  () => notice.value?.kind === 'superseded' || (notice.value?.kind === 'outdated' && updateStuck.value),
)

function reload() {
  location.reload()
}

watch(
  () => notice.value?.kind,
  async (kind) => {
    if (!kind) return
    if (kind === 'outdated') {
      updateStuck.value = !(await updateApp())
      return
    }
    if (kind === 'superseded') return
    setTimeout(() => {
      if (kind === 'deleted') location.reload() // fresh start at the login screen
      else if (notice.value?.kind === kind) tap.tap().dismissNotice()
    }, NOTICE_MS)
  },
  { immediate: true },
)
</script>

<template>
  <!-- app shell: fills the screen; only the content scrolls, the menu bar is its last row -->
  <div class="fixed inset-0 flex flex-col">
    <div v-if="notice" class="banner">
      <span class="text-[13px]">
        <template v-if="notice.kind === 'removed'">{{ t('notice.removed', { name: notice.name }) }}</template>
        <template v-else-if="notice.kind === 'outdated'">{{ updateStuck ? t('notice.outdated') : t('notice.updating') }}</template>
        <template v-else>{{ t(`notice.${notice.kind}`, { app: brand.name }) }}</template>
      </span>
      <button v-if="needsAction" class="btn-secondary btn-sm" @click="reload">
        {{ notice.kind === 'superseded' ? t('notice.useHere') : t('notice.reload') }}
      </button>
    </div>
    <div v-else-if="keptDb" class="banner">
      <span class="text-[13px]">{{ t('notice.dbKept', { kept: tap.dbName, server: brand.dbName }) }}</span>
    </div>
    <div v-else-if="updatedTo" class="banner">
      <span class="text-[13px]">{{ t('notice.updated', { version: displayVersion(updatedTo) }) }}</span>
    </div>
    <!-- touch-manipulation again: WebKit resets touch-action at every scroll container -->
    <main ref="content" class="min-h-0 flex-1 touch-manipulation overflow-y-auto overscroll-contain bg-canvas">
      <RouterView />
    </main>
    <BottomNav v-if="!route.meta.public" />
  </div>
</template>
