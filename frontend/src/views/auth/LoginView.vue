<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { requestLogin } from '../../api/auth'
import { getLocale } from '../../i18n'
import { errorMessage } from '../../utils/errors'
import { canInstall, installPrompt, isInstalled, isIos } from '../../utils/install'
import { brand } from '../../brand'
import LegalLinks from '../../components/LegalLinks.vue'

const iconUrl = 'icons/icon-192.png' // relative to <base href>

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

// install first: the installed app has its own storage, so a browser login would not carry over
const installFirst = ref(!isInstalled() && canInstall())
const fromInvite = typeof route.query.redirect === 'string' && route.query.redirect.includes('/join/')

async function install() {
  await installPrompt.value?.prompt()
  installPrompt.value = null
}

const email = ref('')
const loading = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await requestLogin(email.value.trim(), getLocale())
    router.push({ name: 'verify', query: { email: email.value.trim(), redirect: route.query.redirect } })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page-auth">
    <div class="flex flex-col items-center gap-2 text-center">
      <img :src="iconUrl" alt="" class="size-16 rounded-2xl shadow-sm" />
      <h1>{{ brand.name }}</h1>
      <p>{{ t('login.intro') }}</p>
    </div>
    <section v-if="installFirst" class="card border-primary/40">
      <h2>{{ t('login.installFirst') }}</h2>
      <p>{{ t('login.installWhy') }}</p>
      <p v-if="isIos()" class="text-ink">{{ t('install.ios', { app: brand.name }) }}</p>
      <button v-else-if="installPrompt" class="btn-primary btn-block" @click="install">{{ t('install.button') }}</button>
      <p v-else class="text-ink">{{ t('login.installAndroid', { app: brand.name }) }}</p>
      <p v-if="fromInvite">{{ t('login.installInvite') }}</p>
      <button class="btn-secondary btn-sm self-center" @click="installFirst = false">{{ t('login.continueInBrowser') }}</button>
    </section>
    <form v-else class="card" @submit.prevent="submit">
      <div class="form-group">
        <label for="email">{{ t('login.email') }}</label>
        <input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
      </div>
      <p v-if="error" class="error-message">{{ error }}</p>
      <button type="submit" class="btn-primary btn-block" :disabled="loading">
        {{ loading ? t('login.sending') : t('login.sendCode') }}
      </button>
    </form>
    <p class="text-muted text-center">{{ t('login.privacy') }}</p>
    <LegalLinks />
  </div>
</template>
