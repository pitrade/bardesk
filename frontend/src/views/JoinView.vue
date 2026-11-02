<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { errorMessage } from '../utils/errors'

const { t } = useI18n()
const tap = useTap()
const route = useRoute()
const router = useRouter()

const id = String(route.params.id)
const token = typeof route.query.t === 'string' ? route.query.t : undefined
const displayname = ref('')
const error = ref('')

const joining = computed(() => tap.view.joining.find((j) => j.id === id))
const member = computed(() => !!tap.group(id))

async function join(name?: string) {
  error.value = ''
  try {
    await tap.tap().joinGroup(id, token, name)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function cancel() {
  await tap.tap().cancelJoin(id)
  router.push({ name: 'group' })
}

onMounted(() => {
  // plain group link: we're (supposedly) a member already, just ask for the log
  if (!token && !member.value && !joining.value) void join()
})

watch(
  member,
  async (isMember) => {
    if (!isMember) return
    await tap.tap().setActiveGroup(id)
    router.replace({ name: 'tab' })
  },
  { immediate: true },
)
</script>

<template>
  <div class="page">
    <h1>{{ t('join.title') }}</h1>

    <form v-if="token && !joining" class="card" @submit.prevent="join(displayname.trim())">
      <p>{{ t('join.intro') }}</p>
      <div class="form-group">
        <label for="displayname">{{ t('groups.yourName') }}</label>
        <input id="displayname" v-model="displayname" type="text" required autocomplete="nickname" />
      </div>
      <button class="btn-primary btn-block" type="submit">{{ t('join.button') }}</button>
    </form>

    <section v-else-if="joining" class="card">
      <p v-if="joining.error" class="error-message">{{ t(`join.errors.${joining.error}`) }}</p>
      <template v-else>
        <div class="mx-auto size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p class="text-center">{{ t('join.waiting') }}</p>
        <p class="text-center text-muted">{{ t('join.waitingHint') }}</p>
      </template>
      <button class="btn-secondary btn-block" @click="cancel">{{ t('common.cancel') }}</button>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>
  </div>
</template>
