<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { installPrompt, isInstalled, isIos } from '../utils/install'
import { brand } from '../brand'

const { t } = useI18n()
const DISMISS_KEY = 'bardesk_install_dismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

const dismissed = ref(readDismissed())
const visible = computed(() => !isInstalled() && !dismissed.value && (isIos() || installPrompt.value !== null))

async function install() {
  await installPrompt.value?.prompt()
  installPrompt.value = null
}

function dismiss() {
  dismissed.value = true
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // storage blocked: hide for this session only
  }
}
</script>

<template>
  <section v-if="visible" class="card border-primary/40">
    <h2>{{ t('install.title') }}</h2>
    <p>{{ t('install.why') }}</p>
    <p v-if="isIos()" class="text-ink">{{ t('install.ios', { app: brand.name }) }}</p>
    <div class="flex gap-2">
      <button v-if="installPrompt" class="btn-primary flex-1" @click="install">{{ t('install.button') }}</button>
      <button class="btn-secondary flex-1" @click="dismiss">{{ t('install.later') }}</button>
    </div>
  </section>
</template>
