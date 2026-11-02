<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import { hlcMs } from '../core/hlc'
import { formerWithOpenBalance } from '../core/replay'
import type { Invite, Member, Product } from '../core/types'
import { formatCents } from '../utils/currency'
import { formatDateTime } from '../utils/dates'
import { describeEntry, productNames, saveFile, toCsv } from '../utils/entries'
import { errorMessage } from '../utils/errors'
import CollapsibleCard from './CollapsibleCard.vue'
import QrDialog from './QrDialog.vue'

// the management page of one group; keyed by the group id, so switching groups starts fresh
const props = defineProps<{ id: string }>()

const { t } = useI18n()
const tap = useTap()
const id = computed(() => props.id)
const group = computed(() => tap.group(props.id))

// an error shows in the card whose action failed
type Section = 'members' | 'former' | 'you' | 'details' | 'products' | 'invites' | 'leave'
const error = ref<{ section: Section; message: string } | null>(null)

function errorIn(section: Section): string {
  return error.value?.section === section ? error.value.message : ''
}

const copied = ref('')

async function run(section: Section, action: () => Promise<unknown>) {
  error.value = null
  try {
    await action()
  } catch (e) {
    error.value = { section, message: errorMessage(e) }
  }
}

function euros(cents: number): string {
  return (cents / 100).toFixed(2)
}

function parseCents(text: string): number | null {
  const value = Number(text.replace(',', '.').trim())
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null
}

// ---- links ----
async function share(text: string, key: string) {
  if (navigator.share) {
    try {
      await navigator.share({ url: text })
      return
    } catch {
      // cancelled: fall back to copying
    }
  }
  await navigator.clipboard?.writeText(text)
  copied.value = key
  setTimeout(() => (copied.value = ''), 2000)
}

// ---- group details ----
const editName = ref('')
const editDescription = ref('')
const myName = ref('')

watch(
  group,
  (g) => {
    if (!g) return
    if (!editName.value) editName.value = g.name
    if (!editDescription.value) editDescription.value = g.description
    if (!myName.value) myName.value = g.me?.displayname ?? ''
  },
  { immediate: true },
)

// ---- members ----
const members = computed(() => {
  const g = group.value
  if (!g) return []
  return Object.values(g.state.members)
    .filter((m) => m.status === 'active')
    .sort((a, b) => a.displayname.localeCompare(b.displayname))
})
const former = computed(() => (group.value ? formerWithOpenBalance(group.value.state) : []))

function lastSeen(member: Member): string {
  return member.lastSeen ? formatDateTime(hlcMs(member.lastSeen)) : '–'
}

async function toggleRole(member: Member) {
  await run('members', () => tap.tap().setRole(id.value, member.email, member.role === 'admin' ? 'member' : 'admin'))
}

async function makeMeAdmin() {
  if (confirm(t('group.makeMeAdminConfirm'))) await run('members', () => tap.tap().setRole(id.value, tap.view.email, 'admin'))
}

async function remove(member: Member) {
  if (confirm(t('group.removeConfirm', { name: member.displayname }))) {
    await run('members', () => tap.tap().removeMember(id.value, member.email))
  }
}

// ---- invites ----
const multiUse = ref(false)
const shownInvite = ref<string | null>(null)

const invites = computed(() => {
  const g = group.value
  if (!g) return []
  const now = tap.tap().now()
  return Object.values(g.state.invites)
    .filter((i) => !i.revoked && i.expiresAt > now && (i.multiUse || i.usedCount === 0))
    .sort((a, b) => b.expiresAt - a.expiresAt)
})

function inviteLink(token: string): string {
  return new URL(`join/${id.value}?t=${token}`, document.baseURI).href
}

async function createInvite() {
  await run('invites', () => tap.tap().createInvite(id.value, multiUse.value))
}

function describeInvite(invite: Invite): string {
  const kind = invite.multiUse ? t('group.inviteMulti') : t('group.inviteSingle')
  return `${kind} · ${t('group.validUntil', { time: formatDateTime(invite.expiresAt) })}`
}

// the QR code opens in the foreground; it closes by itself once the invite is used up or revoked
const shownInviteData = computed(() => invites.value.find((i) => i.token === shownInvite.value))

// ---- products ----
const newProductName = ref('')
const newProductPrice = ref('')
const editing = ref<{ id: string; name: string; price: string } | null>(null)

async function addProduct() {
  const price = parseCents(newProductPrice.value)
  if (price === null || !newProductName.value.trim()) {
    error.value = { section: 'products', message: t('group.errors.invalidProduct') }
    return
  }
  await run('products', () => tap.tap().addProduct(id.value, newProductName.value.trim(), price))
  newProductName.value = newProductPrice.value = ''
}

function startEdit(product: Product) {
  editing.value = { id: product.id, name: product.name, price: euros(product.price) }
}

async function saveEdit() {
  const edit = editing.value
  const price = edit ? parseCents(edit.price) : null
  if (!edit || price === null || !edit.name.trim()) {
    error.value = { section: 'products', message: t('group.errors.invalidProduct') }
    return
  }
  await run('products', () => tap.tap().updateProduct(id.value, edit.id, { name: edit.name.trim(), price }))
  editing.value = null
}

async function deleteProduct(product: Product) {
  if (confirm(t('group.deleteProductConfirm', { name: product.name }))) {
    await run('products', () => tap.tap().deleteProduct(id.value, product.id))
  }
}

// ---- log ----
const logLimit = ref(30)
const log = computed(() => {
  const g = group.value
  if (!g) return []
  const names = productNames(g.entries)
  return g.entries
    .filter((e) => !e.type.startsWith('chat.'))
    .reverse()
    .slice(0, logLimit.value)
    .map((e) => ({ key: `${e.device}:${e.seq}`, ...describeEntry(e, g.state, names) }))
})

async function exportCsv() {
  const g = group.value
  if (!g) return
  const date = new Date().toISOString().slice(0, 10)
  await saveFile(`${g.name.replace(/\W+/g, '-')}-${date}.csv`, toCsv(g.entries, g.state), 'text/csv')
}

// ---- leave ----
async function leave() {
  if (!confirm(t('group.leaveConfirm'))) return
  await run('leave', () => tap.tap().leaveGroup(id.value))
}
</script>

<template>
  <template v-if="group">
    <!-- members -->
    <section class="card">
      <h2>{{ t('group.members') }}</h2>
      <div>
        <div v-for="m in members" :key="m.email" class="row">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="flex items-center gap-2 font-medium">
              <span class="size-2 shrink-0 rounded-full" :class="group.online.includes(m.email) ? 'bg-positive' : 'bg-border'" />
              <span class="truncate">{{ m.displayname }}</span>
              <span v-if="m.role === 'admin'" class="badge badge-primary">{{ t('group.admin') }}</span>
            </span>
            <span class="truncate text-muted">{{ t('group.lastSeen', { time: lastSeen(m) }) }} · {{ m.email }}</span>
            <span v-if="group.isAdmin" class="flex gap-2 pt-1">
              <button class="btn-secondary btn-sm" @click="toggleRole(m)">
                {{ m.role === 'admin' ? t('group.demote') : t('group.promote') }}
              </button>
              <button
                v-if="m.email !== tap.view.email"
                class="btn-danger btn-sm"
                :disabled="m.balance !== 0"
                :title="m.balance !== 0 ? t('group.balanceMustBeZero') : ''"
                @click="remove(m)"
              >
                {{ t('group.remove') }}
              </button>
            </span>
          </div>
          <span :class="m.balance >= 0 ? 'positive' : 'negative'">{{ formatCents(m.balance) }}</span>
        </div>
      </div>
      <button v-if="!group.isAdmin" class="btn-secondary btn-sm self-start" @click="makeMeAdmin">{{ t('group.makeMeAdmin') }}</button>
      <p v-if="errorIn('members')" class="error-message">{{ errorIn('members') }}</p>
    </section>

    <!-- former members -->
    <section v-if="former.length" class="card">
      <h2>{{ t('group.formerOpen') }}</h2>
      <div>
        <div v-for="m in former" :key="m.email" class="row">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="truncate font-medium">{{ m.displayname }}</span>
            <span class="truncate text-muted">{{ m.email }}</span>
          </div>
          <span :class="m.balance >= 0 ? 'positive' : 'negative'">{{ formatCents(m.balance) }}</span>
          <button v-if="group.isAdmin" class="btn-secondary btn-sm" @click="run('former', () => tap.tap().settle(id, m.email))">
            {{ t('group.settle') }}
          </button>
        </div>
      </div>
      <p v-if="errorIn('former')" class="error-message">{{ errorIn('former') }}</p>
    </section>

    <!-- you -->
    <CollapsibleCard :title="t('group.you')">
      <form class="flex items-end gap-2" @submit.prevent="run('you', () => tap.tap().setDisplayName(id, myName.trim()))">
        <div class="form-group flex-1">
          <label for="my-name">{{ t('groups.yourName') }}</label>
          <input id="my-name" v-model="myName" type="text" required />
        </div>
        <button class="btn-secondary shrink-0" type="submit">{{ t('common.save') }}</button>
      </form>
      <p v-if="errorIn('you')" class="error-message">{{ errorIn('you') }}</p>
    </CollapsibleCard>

    <!-- admin -->
    <CollapsibleCard v-if="group.isAdmin" :title="t('group.details')">
      <form class="flex flex-col gap-3" @submit.prevent="run('details', () => tap.tap().updateGroup(id, editName.trim(), editDescription.trim()))">
        <div class="form-group">
          <label for="group-name">{{ t('groups.name') }}</label>
          <input id="group-name" v-model="editName" type="text" required />
        </div>
        <div class="form-group">
          <label for="group-description">{{ t('groups.description') }}</label>
          <input id="group-description" v-model="editDescription" type="text" />
        </div>
        <button class="btn-secondary btn-block" type="submit">{{ t('common.save') }}</button>
      </form>
      <p v-if="errorIn('details')" class="error-message">{{ errorIn('details') }}</p>
    </CollapsibleCard>

    <CollapsibleCard v-if="group.isAdmin" :title="t('group.products')">
      <div>
        <div v-for="(p, index) in group.products" :key="p.id" class="row">
          <form v-if="editing?.id === p.id" class="flex flex-1 flex-col gap-2" @submit.prevent="saveEdit">
            <input v-model="editing.name" type="text" required />
            <input v-model="editing.price" type="text" inputmode="decimal" required />
            <div class="flex gap-2">
              <button class="btn-secondary btn-sm" type="button" @click="editing = null">{{ t('common.cancel') }}</button>
              <button class="btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
            </div>
          </form>
          <template v-else>
            <button class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left" @click="startEdit(p)">
              <span class="truncate font-medium" :class="p.soldOut ? 'text-muted line-through' : ''">{{ p.name }}</span>
              <span class="text-muted">{{ formatCents(p.price) }}</span>
            </button>
            <div class="flex shrink-0 gap-1">
              <button class="btn-secondary btn-sm" :disabled="index === 0" :aria-label="t('group.up')" @click="run('products', () => tap.tap().moveProduct(id, p.id, -1))">↑</button>
              <button
                class="btn-secondary btn-sm"
                :disabled="index === group.products.length - 1"
                :aria-label="t('group.down')"
                @click="run('products', () => tap.tap().moveProduct(id, p.id, 1))"
              >
                ↓
              </button>
              <button class="btn-secondary btn-sm" @click="run('products', () => tap.tap().updateProduct(id, p.id, { soldOut: !p.soldOut }))">
                {{ p.soldOut ? t('group.available') : t('group.soldOut') }}
              </button>
              <button class="btn-danger btn-sm" :aria-label="t('common.delete')" @click="deleteProduct(p)">✕</button>
            </div>
          </template>
        </div>
      </div>
      <form class="flex gap-2" @submit.prevent="addProduct">
        <input v-model="newProductName" type="text" :placeholder="t('group.productName')" required />
        <input v-model="newProductPrice" class="w-24 shrink-0" type="text" inputmode="decimal" placeholder="2.50" required />
        <button class="btn-primary shrink-0" type="submit">{{ t('group.add') }}</button>
      </form>
      <p v-if="errorIn('products')" class="error-message">{{ errorIn('products') }}</p>
    </CollapsibleCard>

    <CollapsibleCard v-if="group.isAdmin" :title="t('group.invites')">
      <label class="flex items-center gap-3 text-[15px]">
        <input v-model="multiUse" type="checkbox" class="size-5 appearance-auto" />
        {{ t('group.multiUse') }}
      </label>
      <button class="btn-primary btn-block" @click="createInvite">{{ t('group.createInvite') }}</button>
      <p v-if="errorIn('invites')" class="error-message">{{ errorIn('invites') }}</p>
      <div v-for="invite in invites" :key="invite.token" class="flex flex-col gap-2 border-t border-border/60 pt-3">
        <p class="text-muted">{{ describeInvite(invite) }}</p>
        <div class="flex gap-2">
          <button class="btn-secondary btn-sm" @click="shownInvite = invite.token">
            {{ t('group.qr') }}
          </button>
          <button class="btn-secondary btn-sm" @click="share(inviteLink(invite.token), invite.token)">
            {{ copied === invite.token ? t('common.copied') : t('group.share') }}
          </button>
          <button class="btn-danger btn-sm" @click="run('invites', () => tap.tap().revokeInvite(id, invite.token))">{{ t('group.revoke') }}</button>
        </div>
      </div>
      <QrDialog
        v-if="shownInviteData"
        :value="inviteLink(shownInviteData.token)"
        :caption="describeInvite(shownInviteData)"
        @close="shownInvite = null"
      />
    </CollapsibleCard>

    <!-- log -->
    <CollapsibleCard :title="t('group.log')">
      <button class="btn-secondary btn-sm self-start" @click="exportCsv">{{ t('group.csv') }}</button>
      <div>
        <div v-for="line in log" :key="line.key" class="row">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="truncate font-medium">{{ line.what }}</span>
            <span class="truncate text-muted">{{ line.who }} · {{ formatDateTime(line.time) }}</span>
          </div>
          <span v-if="line.amount !== null" :class="line.amount >= 0 ? 'positive' : 'negative'">{{ formatCents(line.amount) }}</span>
        </div>
      </div>
      <button v-if="log.length >= logLimit" class="btn-secondary btn-sm self-center" @click="logLimit += 50">
        {{ t('group.showMore') }}
      </button>
    </CollapsibleCard>

    <button class="btn-danger btn-block" :disabled="group.balance !== 0" @click="leave">{{ t('group.leave') }}</button>
    <p v-if="errorIn('leave')" class="error-message">{{ errorIn('leave') }}</p>
    <p v-if="group.balance !== 0" class="text-muted text-center">{{ t('group.balanceMustBeZero') }}</p>
  </template>
</template>
