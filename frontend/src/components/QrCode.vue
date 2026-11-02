<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { ref, watchEffect } from 'vue'
import QRCode from 'qrcode'

const props = defineProps<{ value: string }>()
const src = ref('')

watchEffect(async () => {
  src.value = await QRCode.toDataURL(props.value, { margin: 1, width: 320 })
})
</script>

<template>
  <img v-if="src" :src="src" :alt="value" class="aspect-square w-full rounded-xl bg-white p-2" />
</template>
