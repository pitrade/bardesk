<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { MAX_MESSAGE_LENGTH } from '../core/client'
import { hlcMs } from '../core/hlc'
import type { ChatMessage } from '../core/types'
import { formatDateTime } from '../utils/dates'
import GroupHeader from '../components/GroupHeader.vue'
import { errorMessage } from '../utils/errors'

const { t } = useI18n()
const tap = useTap()

// chat of the active group (picked on the Group page)
const group = computed(() => tap.group(tap.view.activeGroupId))
const text = ref('')
const error = ref('')
const bottom = ref<HTMLElement | null>(null)

function isMine(message: ChatMessage): boolean {
  return message.author === tap.view.email
}

function nameOf(email: string): string {
  return group.value?.state.members[email]?.displayname ?? email
}

async function send() {
  if (!group.value || !text.value.trim()) return
  error.value = ''
  try {
    await tap.tap().sendMessage(group.value.id, text.value)
    text.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function remove(id: string) {
  if (group.value && confirm(t('chat.deleteConfirm'))) await tap.tap().deleteMessage(group.value.id, id)
}

// own messages are deleted by a long press (scrolling cancels the pointer, and with it the press)
const LONG_PRESS_MS = 400
let pressTimer: ReturnType<typeof setTimeout> | undefined

function pressStart(message: ChatMessage) {
  clearTimeout(pressTimer)
  if (isMine(message)) pressTimer = setTimeout(() => remove(message.id), LONG_PRESS_MS)
}

function pressEnd() {
  clearTimeout(pressTimer)
}

// keep the newest message in view
async function scrollToNewest() {
  await nextTick()
  bottom.value?.scrollIntoView({ block: 'end' })
}

onMounted(scrollToNewest)
watch(() => [group.value?.id, group.value?.messages.length], scrollToNewest)
</script>

<template>
  <!-- min-h-full + mt-auto: the message field sits at the bottom, sticky while the messages scroll -->
  <div class="page min-h-full pb-0">
    <template v-if="group">
      <GroupHeader />
      <p class="text-muted">{{ t('chat.hint') }}</p>

      <div v-if="group.messages.length === 0" class="empty-state">{{ t('chat.empty') }}</div>
      <div v-else class="flex flex-col gap-2">
        <div
          v-for="m in group.messages"
          :key="m.id"
          class="flex w-4/5 flex-col gap-0.5 rounded-2xl border border-border px-3.5 py-2"
          :class="isMine(m) ? 'self-end bg-primary/15 select-none [-webkit-touch-callout:none]' : 'self-start bg-surface'"
          @pointerdown="pressStart(m)"
          @pointerup="pressEnd"
          @pointerleave="pressEnd"
          @pointercancel="pressEnd"
          @contextmenu="isMine(m) && $event.preventDefault()"
        >
          <span class="flex items-center justify-between gap-3 text-[11px] text-muted">
            <span v-if="!isMine(m)" class="truncate font-semibold">{{ nameOf(m.author) }}</span>
            <span class="ml-auto shrink-0">{{ formatDateTime(hlcMs(m.hlc)) }}</span>
          </span>
          <span class="text-[15px] break-words whitespace-pre-wrap">{{ m.text }}</span>
        </div>
      </div>

      <form ref="bottom" class="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 border-t border-border bg-canvas px-4 py-3" @submit.prevent="send">
        <p v-if="error" class="error-message">{{ error }}</p>
        <div class="flex items-end gap-2">
          <textarea v-model="text" rows="1" :maxlength="MAX_MESSAGE_LENGTH" :placeholder="t('chat.placeholder')" />
          <button class="btn-primary shrink-0" type="submit" :disabled="!text.trim()">{{ t('chat.send') }}</button>
        </div>
      </form>
    </template>

    <div v-else class="empty-state">
      <p>{{ t('tab.noGroup') }}</p>
      <RouterLink :to="{ name: 'group' }" class="btn-primary">{{ t('tab.goToGroups') }}</RouterLink>
    </div>
  </div>
</template>
