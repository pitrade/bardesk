<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { decodeQr } from '../utils/qr'

const emit = defineEmits<{ result: [text: string]; close: [] }>()
const { t } = useI18n()

const video = ref<HTMLVideoElement | null>(null)
/** camera refused ('denied') or missing ('none'): shown instead of a black video area */
const problem = ref<'denied' | 'none' | null>(null)
/** iOS may refuse to start the video without a tap: then we ask for one */
const needsTap = ref(false)
const canvas = document.createElement('canvas')
const context = canvas.getContext('2d', { willReadFrequently: true })
let stream: MediaStream | undefined
let frame = 0

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch (e) {
    problem.value = (e as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'none'
    return
  }
  const v = video.value
  if (!v) return
  // iOS only plays camera video inline when these are set before the stream is attached
  v.muted = true
  v.setAttribute('muted', '')
  v.setAttribute('playsinline', '')
  v.setAttribute('webkit-playsinline', '')
  v.srcObject = stream
  await start()
  scan()
})

async function start() {
  try {
    await video.value?.play()
    needsTap.value = false
  } catch {
    needsTap.value = true
  }
}

/** Look for a QR code in every video frame (downscaled for speed). */
function scan() {
  const v = video.value
  if (v && context && v.readyState >= 2 && v.videoWidth) {
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight))
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    context.drawImage(v, 0, 0, canvas.width, canvas.height)
    const text = decodeQr(context.getImageData(0, 0, canvas.width, canvas.height))
    if (text) {
      stop()
      emit('result', text)
      return
    }
  }
  frame = requestAnimationFrame(scan)
}

function stop() {
  cancelAnimationFrame(frame)
  stream?.getTracks().forEach((track) => track.stop())
}

onUnmounted(stop)
</script>

<template>
  <div class="absolute inset-0 z-50 flex flex-col bg-black">
    <div v-if="problem" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 class="text-[#f87171]">{{ problem === 'denied' ? t('scanner.denied') : t('scanner.noCamera') }}</h2>
      <p v-if="problem === 'denied'" class="text-white/75">{{ t('scanner.deniedHelp') }}</p>
      <p class="text-white/75">{{ t('scanner.pasteInstead') }}</p>
    </div>
    <template v-else>
      <p class="px-4 py-3 text-center text-white">{{ t('scanner.hint') }}</p>
      <div class="relative flex-1 overflow-hidden">
        <video ref="video" class="size-full object-cover" playsinline muted autoplay />
        <div class="pointer-events-none absolute inset-0 m-auto size-60 rounded-2xl border-2 border-white/80" />
        <button v-if="needsTap" class="btn-primary absolute inset-x-8 top-1/2 -translate-y-1/2" @click="start">
          {{ t('scanner.tapToStart') }}
        </button>
      </div>
    </template>
    <div class="p-4">
      <button class="btn-secondary btn-block" @click="emit('close')">{{ t('common.cancel') }}</button>
    </div>
  </div>
</template>
