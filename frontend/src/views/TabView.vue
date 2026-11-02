<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { UNDO_WINDOW_MS } from '../core/client'
import { brand } from '../brand'
import type { EntryDataMap, Product } from '../core/types'
import { formatCents } from '../utils/currency'
import { formatDateTime } from '../utils/dates'
import { describeEntry, productNames, purchaseLabel } from '../utils/entries'
import { chargedMember, purchaseTotal } from '../core/replay'
import { errorMessage } from '../utils/errors'
import CollapsibleCard from '../components/CollapsibleCard.vue'
import GroupHeader from '../components/GroupHeader.vue'
import InstallHint from '../components/InstallHint.vue'
import QuantityDialog from '../components/QuantityDialog.vue'

const { t } = useI18n()
const tap = useTap()

const group = computed(() => tap.group(tap.view.activeGroupId))
const error = ref('')

// ---- buying with undo ----
const lastPurchase = ref<{ id: string; label: string; total: number } | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | undefined

async function buy(product: Product, quantity = 1): Promise<string | undefined> {
  if (!group.value) return
  error.value = ''
  try {
    const id = await tap.tap().purchase(group.value.id, product, quantity)
    const data = { productId: product.id, name: product.name, price: product.price, quantity }
    lastPurchase.value = { id, label: purchaseLabel(data), total: purchaseTotal(data) }
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (lastPurchase.value = null), UNDO_WINDOW_MS)
    return id
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function undo(id: string) {
  lastTap = null // an undone booking can't be the first half of a double tap
  if (lastPurchase.value?.id === id) {
    lastPurchase.value = null
    clearTimeout(hideTimer)
  }
  await tap.tap().undo(id)
}

// A tap books one at once. A double tap or a long press opens the quantity dialog instead;
// the double tap's first tap is still in its undo window, so it is simply undone.
const DOUBLE_TAP_MS = 400
const LONG_PRESS_MS = 400
const quantityFor = ref<Product | null>(null)
let lastTap: { productId: string; at: number; booking: Promise<string | undefined> } | null = null
let pressTimer: ReturnType<typeof setTimeout> | undefined
let longPressed = false // the click that ends a long press books nothing

function pressStart(product: Product) {
  longPressed = false
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    longPressed = true
    quantityFor.value = product
  }, LONG_PRESS_MS)
}

function pressEnd() {
  clearTimeout(pressTimer)
}

async function tapProduct(product: Product) {
  if (longPressed) return
  const now = Date.now()
  if (lastTap?.productId === product.id && now - lastTap.at < DOUBLE_TAP_MS) {
    const booking = lastTap.booking
    lastTap = null
    quantityFor.value = product
    const id = await booking
    if (id) await undo(id)
    return
  }
  lastTap = { productId: product.id, at: now, booking: buy(product) }
}

onUnmounted(() => clearTimeout(hideTimer))

// ---- top up / correction (form opens from the balance card) ----
const showTopup = ref(false)
const amountInput = ref('')
const description = ref('')
const saving = ref(false)
const quickAmounts = brand.topupAmounts

function parseCents(): number | null {
  const value = Number(amountInput.value.replace(',', '.').replace(/\s/g, ''))
  if (!Number.isFinite(value) || value === 0) return null
  return Math.round(value * 100)
}

async function saveTopup() {
  if (!group.value) return
  const cents = parseCents()
  if (cents === null) {
    error.value = t('tab.errors.invalidAmount')
    return
  }
  saving.value = true
  error.value = ''
  try {
    await tap.tap().topup(group.value.id, cents, description.value.trim())
    closeTopup()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

// decimal keypads may have no minus key (Gboard has none), so the sign has its own button
function toggleSign() {
  amountInput.value = amountInput.value.startsWith('-') ? amountInput.value.slice(1) : `-${amountInput.value}`
}

function closeTopup() {
  showTopup.value = false
  amountInput.value = ''
  description.value = ''
}

// ---- activity (collapsed until opened) ----
const activity = computed(() => {
  const g = group.value
  if (!g) return []
  const names = productNames(g.entries)
  const mine = g.entries
    .filter((e) => {
      if (e.type === 'purchase') return chargedMember(e.data as EntryDataMap['purchase'], e.author) === tap.view.email
      if (e.type === 'topup') return e.author === tap.view.email
      return e.type === 'settled' && (e.data as { email: string }).email === tap.view.email
    })
    .map((e) => ({ key: `${e.device}:${e.seq}`, pending: false, ...describeEntry(e, g.state, names) }))
  const pending = g.pending
    .filter((p) => chargedMember(p.data, p.author) === tap.view.email)
    .map((p) => ({
    key: p.id,
    pending: true,
    what: purchaseLabel(p.data),
    amount: -purchaseTotal(p.data),
    time: 0,
  }))
  return [...pending, ...mine.reverse()].slice(0, 20)
})
</script>

<template>
  <div class="page">
    <GroupHeader />

    <template v-if="group">
      <section class="card">
        <div class="flex items-end justify-between gap-3">
          <div class="balance" :class="group.balance >= 0 ? 'positive' : 'negative'">{{ formatCents(group.balance) }}</div>
          <button
            class="btn-secondary btn-sm"
            :aria-expanded="showTopup"
            @click="showTopup ? closeTopup() : (showTopup = true)"
          >
            {{ t('tab.topup') }} {{ showTopup ? '▲' : '▼' }}
          </button>
        </div>
        <template v-if="showTopup">
          <form class="form-group border-t border-border/60 pt-3" @submit.prevent="saveTopup">
            <div class="flex gap-2">
              <button class="btn-secondary shrink-0" type="button" :aria-label="t('tab.toggleSign')" @click="toggleSign">±</button>
              <input v-model="amountInput" type="text" inputmode="decimal" :placeholder="t('tab.amountPlaceholder')" />
              <button class="btn-primary shrink-0" type="submit" :disabled="saving || !amountInput">{{ t('common.save') }}</button>
            </div>
            <div class="grid grid-cols-3 gap-2 pt-1">
              <button
                v-for="euros in quickAmounts"
                :key="euros"
                class="btn-secondary btn-sm"
                type="button"
                @click="amountInput = euros.toFixed(2)"
              >
                +{{ formatCents(euros * 100).replace(/[.,]00(?=\D|$)/, '') }}
              </button>
            </div>
            <input v-model="description" type="text" :placeholder="t('tab.descriptionPlaceholder')" />
          </form>
          <p class="text-muted">{{ t('tab.topupHint') }}</p>
        </template>
      </section>

      <p v-if="error" class="error-message">{{ error }}</p>

      <div v-if="group.products.length === 0" class="empty-state">
        {{ t('tab.noProducts') }}
        <RouterLink :to="{ name: 'group' }" class="btn-secondary btn-sm">{{ t('tab.manage') }}</RouterLink>
      </div>
      <p v-else class="text-muted">{{ t('tab.productsHint') }}</p>
      <div v-if="group.products.length" class="grid grid-cols-2 gap-3">
        <button
          v-for="product in group.products"
          :key="product.id"
          class="flex min-h-20 flex-col items-start justify-between gap-2 rounded-2xl border border-border bg-surface p-4 text-left transition select-none [-webkit-touch-callout:none] active:scale-[0.97] active:border-primary disabled:opacity-40"
          :disabled="product.soldOut"
          @click="tapProduct(product)"
          @pointerdown="pressStart(product)"
          @pointerup="pressEnd"
          @pointerleave="pressEnd"
          @pointercancel="pressEnd"
          @contextmenu.prevent
        >
          <span class="text-[15px] leading-snug font-semibold">{{ product.name }}</span>
          <span class="text-[13px] text-muted tabular-nums">
            {{ product.soldOut ? t('tab.soldOut') : formatCents(product.price) }}
          </span>
        </button>
      </div>

      <CollapsibleCard v-if="activity.length" :title="t('tab.myActivity')">
        <div>
          <div v-for="item in activity" :key="item.key" class="row">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate font-medium">{{ item.what }}</span>
              <span class="text-muted">{{ item.pending ? t('tab.pending') : formatDateTime(item.time) }}</span>
            </div>
            <span :class="(item.amount ?? 0) >= 0 ? 'positive' : 'negative'">{{ formatCents(item.amount ?? 0) }}</span>
          </div>
        </div>
      </CollapsibleCard>

      <InstallHint />

      <div
        v-if="lastPurchase"
        class="toast absolute inset-x-4 bottom-19 z-30 py-2.5"
      >
        <span class="text-[13px]">{{ t('tab.bought', { name: lastPurchase.label, price: formatCents(lastPurchase.total) }) }}</span>
        <button class="btn-secondary btn-sm" @click="undo(lastPurchase.id)">{{ t('tab.undo') }}</button>
      </div>

      <QuantityDialog
        v-if="quantityFor"
        :product="quantityFor"
        @book="(quantity) => buy(quantityFor!, quantity)"
        @close="quantityFor = null"
      />
    </template>

    <template v-else>
      <div class="empty-state">
        <p>{{ t('tab.noGroup') }}</p>
        <RouterLink :to="{ name: 'group' }" class="btn-primary">{{ t('tab.goToGroups') }}</RouterLink>
      </div>
      <InstallHint />
    </template>
  </div>
</template>
