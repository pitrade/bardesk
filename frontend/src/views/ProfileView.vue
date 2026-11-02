<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { getLocale, setLocale, type Locale } from '../i18n'
import { saveFile } from '../utils/entries'
import { errorMessage } from '../utils/errors'
import CollapsibleCard from '../components/CollapsibleCard.vue'
import InstallHint from '../components/InstallHint.vue'
import { displayVersion } from '../utils/update'
import LegalLinks from '../components/LegalLinks.vue'
import { brand } from '../brand'

const { t } = useI18n()
const tap = useTap()

const language = ref<Locale>(getLocale())
const error = ref('')
const message = ref('')

async function exportData() {
  const date = new Date().toISOString().slice(0, 10)
  await saveFile(`bardesk-${date}.json`, JSON.stringify(tap.tap().exportData()), 'application/json')
}

async function importData(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = message.value = ''
  try {
    const added = await tap.tap().importData(JSON.parse(await file.text()))
    message.value = t('profile.imported', { n: added })
  } catch (e) {
    error.value = e instanceof SyntaxError ? t('profile.errors.invalidFile', { app: brand.name }) : errorMessage(e)
  }
}

function deleteAccount() {
  if (!confirm(t('profile.deleteConfirm'))) return
  error.value = ''
  try {
    tap.tap().deleteAccount()
  } catch (e) {
    error.value = errorMessage(e)
  }
}
</script>

<template>
  <div class="page">
    <section class="card">
      <dl>
        <div class="row">
          <dt class="text-muted">{{ t('profile.email') }}</dt>
          <dd class="min-w-0 truncate">{{ tap.view.email }}</dd>
        </div>
        <div class="row">
          <dt class="text-muted">{{ t('profile.connection') }}</dt>
          <dd class="text-right">{{ t(`profile.status.${tap.view.relayStatus}`) }}</dd>
        </div>
        <div class="row">
          <dt class="text-muted">{{ t('profile.version') }}</dt>
          <dd>{{ displayVersion() }}</dd>
        </div>
      </dl>
      <div class="form-group">
        <label for="language">{{ t('profile.language') }}</label>
        <select id="language" v-model="language" @change="setLocale(language)">
          <option value="de">{{ t('profile.languageGerman') }}</option>
          <option value="en">{{ t('profile.languageEnglish') }}</option>
        </select>
      </div>
    </section>

    <InstallHint />

    <CollapsibleCard :title="t('profile.privacyTitle')">
      <p>{{ t('profile.privacy') }}</p>
    </CollapsibleCard>

    <section class="card">
      <h2>{{ t('profile.backup') }}</h2>
      <p>{{ t('profile.backupHint') }}</p>
      <div class="grid grid-cols-2 gap-2">
        <button class="btn-secondary" @click="exportData">{{ t('profile.export') }}</button>
        <label class="btn-secondary">
          {{ t('profile.import') }}
          <input type="file" accept="application/json,.json" class="hidden" @change="importData" />
        </label>
      </div>
      <p v-if="message" class="text-muted">{{ message }}</p>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>

    <section class="card">
      <h2>{{ t('profile.deleteTitle') }}</h2>
      <p>{{ tap.view.groups.length ? t('profile.deleteBlocked') : t('profile.deleteHint') }}</p>
      <button class="btn-danger btn-block" :disabled="tap.view.groups.length > 0" @click="deleteAccount">
        {{ t('profile.delete') }}
      </button>
    </section>
    <LegalLinks />
  </div>
</template>
