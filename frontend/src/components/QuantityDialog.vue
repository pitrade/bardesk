<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Product } from '../core/types'
import { formatCents } from '../utils/currency'

// book several of one product (modal dialog; Cancel or Escape close it, no tap outside,
// since the long press that opens it ends outside the dialog)
const props = defineProps<{ product: Product }>()
const emit = defineEmits<{ close: []; book: [quantity: number] }>()

const MAX = 99
const { t } = useI18n()
const dialog = ref<HTMLDialogElement | null>(null)
const text = ref('1')
const quantity = computed(() => {
  const n = Number(text.value)
  return Number.isInteger(n) && n >= 1 && n <= MAX ? n : null
})

function step(delta: number) {
  text.value = String(Math.min(MAX, Math.max(1, (quantity.value ?? 1) + delta)))
}

function book() {
  if (quantity.value === null) return
  emit('book', quantity.value)
  dialog.value?.close()
}

onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="m-auto bg-transparent backdrop:bg-black/60" @close="emit('close')">
    <form class="card w-80 max-w-full text-ink" @submit.prevent="book">
      <div>
        <p class="text-[17px] font-semibold text-heading">{{ props.product.name }}</p>
        <p class="text-muted">{{ t('tab.each', { price: formatCents(props.product.price) }) }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-secondary shrink-0" type="button" :aria-label="t('tab.fewer')" :disabled="(quantity ?? 1) <= 1" @click="step(-1)">−</button>
        <input v-model="text" class="text-center tabular-nums" type="text" inputmode="numeric" :aria-label="t('tab.quantity')" />
        <button class="btn-secondary shrink-0" type="button" :aria-label="t('tab.more')" :disabled="(quantity ?? 0) >= MAX" @click="step(1)">+</button>
      </div>
      <div class="flex gap-2">
        <button class="btn-secondary flex-1" type="button" @click="dialog?.close()">{{ t('common.cancel') }}</button>
        <button class="btn-primary flex-1" type="submit" autofocus :disabled="quantity === null">
          {{ t('tab.book', { price: formatCents(props.product.price * (quantity ?? 0)) }) }}
        </button>
      </div>
    </form>
  </dialog>
</template>
