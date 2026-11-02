<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { brand } from '../brand'

const { t } = useI18n()
</script>

<template>
  <p v-if="brand.imprintUrl || brand.privacyUrl" class="flex justify-center gap-4 text-center text-muted">
    <a v-if="brand.imprintUrl" :href="brand.imprintUrl" target="_blank" rel="noopener" class="underline">{{ t('legal.imprint') }}</a>
    <a v-if="brand.privacyUrl" :href="brand.privacyUrl" target="_blank" rel="noopener" class="underline">{{ t('legal.privacy') }}</a>
  </p>
</template>
