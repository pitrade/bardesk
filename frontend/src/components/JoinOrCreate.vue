<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { errorMessage } from '../utils/errors'
import { parseJoinLink } from '../utils/links'
import { brand } from '../brand'

// the scanner (and the QR decoder) only loads when used
const QrScanner = defineAsyncComponent(() => import('./QrScanner.vue'))

const { t } = useI18n()
const tap = useTap()
const router = useRouter()

const error = ref('')
// one slim row of two buttons; each opens its form below
const open = ref<'create' | 'join' | null>(null)

function toggle(form: 'create' | 'join') {
  open.value = open.value === form ? null : form
}

// ---- create ----
const name = ref('')
const description = ref('')
const displayname = ref('')

async function create() {
  error.value = ''
  try {
    const id = await tap.tap().createGroup(name.value.trim(), description.value.trim(), displayname.value.trim())
    await tap.tap().setActiveGroup(id)
    name.value = description.value = displayname.value = ''
    open.value = null
  } catch (e) {
    error.value = errorMessage(e)
  }
}

// ---- join by scanned or pasted link ----
const link = ref('')
const scanning = ref(false)

function openLink(text = link.value) {
  error.value = ''
  scanning.value = false
  const target = parseJoinLink(text)
  if (!target) {
    error.value = t('groups.errors.invalidLink', { app: brand.name })
    return
  }
  router.push({ name: 'join', params: { id: target.id }, query: target.token ? { t: target.token } : {} })
}
</script>

<template>
  <p v-if="error" class="error-message">{{ error }}</p>

  <div class="grid grid-cols-2 gap-2">
    <button class="btn-secondary btn-sm" :aria-expanded="open === 'create'" @click="toggle('create')">
      {{ t('groups.create') }} {{ open === 'create' ? '▲' : '▼' }}
    </button>
    <button class="btn-secondary btn-sm" :aria-expanded="open === 'join'" @click="toggle('join')">
      {{ t('groups.joinTitle') }} {{ open === 'join' ? '▲' : '▼' }}
    </button>
  </div>

  <section v-if="open === 'create'" class="card">
    <form class="flex flex-col gap-3" @submit.prevent="create">
      <div class="form-group">
        <label for="name">{{ t('groups.name') }}</label>
        <input id="name" v-model="name" type="text" required />
      </div>
      <div class="form-group">
        <label for="description">{{ t('groups.description') }}</label>
        <input id="description" v-model="description" type="text" />
      </div>
      <div class="form-group">
        <label for="displayname">{{ t('groups.yourName') }}</label>
        <input id="displayname" v-model="displayname" type="text" required />
      </div>
      <button class="btn-primary btn-block" type="submit">{{ t('groups.createButton') }}</button>
    </form>
  </section>

  <section v-if="open === 'join'" class="card">
    <p>{{ t('groups.joinHint') }}</p>
    <button class="btn-primary btn-block" @click="scanning = true">{{ t('groups.scan') }}</button>
    <form class="flex gap-2" @submit.prevent="openLink()">
      <input v-model="link" type="url" :placeholder="t('groups.linkPlaceholder')" required />
      <button class="btn-secondary" type="submit">{{ t('groups.open') }}</button>
    </form>
  </section>

  <QrScanner v-if="scanning" @result="openLink" @close="scanning = false" />
</template>
