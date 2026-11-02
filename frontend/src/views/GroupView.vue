<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTap } from '../stores/tap'
import GroupHeader from '../components/GroupHeader.vue'
import GroupManage from '../components/GroupManage.vue'
import JoinOrCreate from '../components/JoinOrCreate.vue'

const { t } = useI18n()
const tap = useTap()

// the active group, also shown on Tab and Chat; it is picked here only
const group = computed(() => tap.group(tap.view.activeGroupId))

async function switchGroup(event: Event) {
  await tap.tap().setActiveGroup((event.target as HTMLSelectElement).value)
}

async function cancelJoin(id: string) {
  await tap.tap().cancelJoin(id)
}
</script>

<template>
  <div class="page">
    <GroupHeader />
    <p v-if="group?.description">{{ group.description }}</p>
    <div v-if="group && tap.view.groups.length > 1" class="form-group">
      <label for="group-picker">{{ t('groups.pick') }}</label>
      <select id="group-picker" :value="group.id" @change="switchGroup">
        <option v-for="g in tap.view.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
    </div>

    <section v-for="j in tap.view.joining" :key="j.id" class="card">
      <h2>{{ t('join.title') }}</h2>
      <p v-if="j.error" class="error-message">{{ t(`join.errors.${j.error}`) }}</p>
      <p v-else>{{ t('join.waiting') }}</p>
      <button class="btn-secondary btn-sm" @click="cancelJoin(j.id)">{{ t('common.cancel') }}</button>
    </section>

    <div v-if="!group" class="empty-state">{{ t('groups.empty') }}</div>
    <JoinOrCreate />
    <GroupManage v-if="group" :key="group.id" :id="group.id" />
  </div>
</template>
