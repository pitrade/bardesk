// SPDX-License-Identifier: GPL-3.0-or-later
import { createRouter, createWebHistory } from 'vue-router'
import { useTap } from '../stores/tap'
// pages are bundled (not lazy-loaded): the app is small and page switches must be instant
import ChatView from '../views/ChatView.vue'
import GroupView from '../views/GroupView.vue'
import JoinView from '../views/JoinView.vue'
import ProfileView from '../views/ProfileView.vue'
import TabView from '../views/TabView.vue'
import LoginView from '../views/auth/LoginView.vue'
import VerifyView from '../views/auth/VerifyView.vue'

const router = createRouter({
  history: createWebHistory(), // base from <base href> (BASE_PATH, set by the render step)
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true },
    },
    {
      path: '/verify',
      name: 'verify',
      component: VerifyView,
      meta: { public: true },
    },
    { path: '/', name: 'tab', component: TabView },
    // Tab, Chat and Group all show the active group, which is picked on the Group page
    { path: '/chat', name: 'chat', component: ChatView },
    { path: '/group', name: 'group', component: GroupView },
    // invite link (?t=token) or plain group link (rejoin)
    { path: '/join/:id', name: 'join', component: JoinView },
    { path: '/profile', name: 'profile', component: ProfileView },
    { path: '/:pathMatch(.*)*', redirect: { name: 'tab' } },
  ],
})

router.beforeEach((to) => {
  const loggedIn = !!useTap().view.email
  const isPublic = to.meta.public === true

  if (!isPublic && !loggedIn) {
    // come back to the invite link after logging in
    return { name: 'login', query: to.name === 'join' ? { redirect: to.fullPath } : {} }
  }
  if (isPublic && loggedIn) return { name: 'tab' }
  return true
})

export default router
