<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { requestLogin, verifyLogin } from '../../api/auth'
import { exportPublicKey, generateKeyPair } from '../../core/crypto'
import { getLocale } from '../../i18n'
import { useTap } from '../../stores/tap'
import { errorMessage } from '../../utils/errors'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const tap = useTap()

const email = (route.query.email as string) ?? ''
const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
const code = ref('')
const loading = ref(false)
const error = ref('')
const resent = ref(false)

if (!email) router.replace({ name: 'login' })

async function submit() {
  error.value = ''
  loading.value = true
  try {
    // the key pair is created on this device; only the public key leaves it
    const keyPair = await generateKeyPair()
    const result = await verifyLogin(email, code.value.trim(), await exportPublicKey(keyPair.publicKey))
    await tap.tap().setIdentity(result.email, keyPair, result.time)
    router.push(redirect || { name: tap.view.groups.length ? 'tab' : 'group' })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

// submit as soon as all 6 digits are typed (or pasted from the email)
watch(code, (value) => {
  if (value.trim().length === 6 && !loading.value) submit()
})

async function resend() {
  error.value = ''
  resent.value = false
  try {
    await requestLogin(email, getLocale())
    resent.value = true
  } catch (e) {
    error.value = errorMessage(e)
  }
}
</script>

<template>
  <div class="page-auth">
    <div class="flex flex-col items-center gap-2 text-center">
      <h1>{{ t('verify.title') }}</h1>
      <p>{{ t('verify.intro') }}<br /><strong class="text-ink">{{ email }}</strong></p>
    </div>
    <form class="card" @submit.prevent="submit">
      <div class="form-group">
        <label for="code" class="sr-only">{{ t('verify.code') }}</label>
        <input
          id="code"
          v-model="code"
          class="h-14 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          required
          autocomplete="one-time-code"
          placeholder="······"
        />
      </div>
      <p v-if="error" class="error-message">{{ error }}</p>
      <p v-if="resent" class="text-muted text-center">{{ t('verify.codeResent') }}</p>
      <button type="submit" class="btn-primary btn-block" :disabled="loading">
        {{ loading ? t('verify.verifying') : t('verify.verify') }}
      </button>
    </form>
    <button class="btn-secondary btn-block" @click="resend">{{ t('verify.resendCode') }}</button>
  </div>
</template>
