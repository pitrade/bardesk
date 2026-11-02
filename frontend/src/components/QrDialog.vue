<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import QrCode from './QrCode.vue'

// a QR code in the foreground (modal dialog: backdrop, Escape and tapping outside close it)
defineProps<{ value: string; caption: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const dialog = ref<HTMLDialogElement | null>(null)

onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="m-auto bg-transparent backdrop:bg-black/60" @close="emit('close')" @click.self="dialog?.close()">
    <div class="card w-80 max-w-full text-ink">
      <QrCode :value="value" />
      <p class="text-center">{{ caption }}</p>
      <button class="btn-secondary btn-block" @click="dialog?.close()">{{ t('common.close') }}</button>
    </div>
  </dialog>
</template>
