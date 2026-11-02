// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * UI flows on (emulated) phones. Each `phone()` is an isolated device with its
 * own storage and key; the backend and relay are real, the app is the rendered build.
 */
import { chromium, devices, expect, test } from '@playwright/test'
import {
  balance,
  createGroup,
  createInvite,
  deployedVersion,
  email,
  joinVia,
  login,
  phone,
  qrVideo,
  render,
  setVisibility,
} from './helpers'

test('first login lands on Group; create a group with products', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await login(page, email('solo'))
  await expect(page).toHaveURL(/\/group$/)
  await expect(page.getByText('No groups yet')).toBeVisible()

  await createGroup(page, 'Solo Pub', 'Sam', [
    ['Beer', '2.50'],
    ['Cola', '2'],
  ])
  await page.getByRole('link', { name: 'Tab' }).click()
  await expect(page.getByRole('button', { name: /Beer.*€2\.50/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Cola.*€2\.00/ })).toBeVisible()
  await expect(balance(page)).toHaveText('€0.00')
  // an error shows in the card whose action failed
  await page.getByRole('link', { name: 'Group', exact: true }).click()
  await page.getByRole('button', { name: /^Products/ }).click()
  await page.getByPlaceholder('Product').fill('Wine')
  await page.getByPlaceholder('2.50').fill('cheap')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.card', { hasText: 'Products' }).locator('.error-message')).toHaveText(/name and a price/)
})

test('the group picker on the Group page sets the group for Tab and Chat', async ({ page }) => {
  await login(page, email('picker'))
  await createGroup(page, 'First Pub', 'Pia', [['Beer', '2.50']])
  await page.getByRole('button', { name: 'Create a group' }).click()
  await page.getByLabel('Group name').fill('Second Pub')
  await page.getByLabel('Your name in this group').fill('Pia')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Second Pub' })).toBeVisible()
  await expect(page.getByLabel('Group name')).toHaveCount(0) // closes after creating

  await page.getByLabel('Switch group').selectOption({ label: 'First Pub' })
  await expect(page.getByRole('heading', { name: 'First Pub' })).toBeVisible()
  await page.getByRole('link', { name: 'Tab' }).click()
  await expect(page.getByRole('button', { name: /Beer/ })).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveCount(0) // no picker on Tab
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'First Pub' })).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveCount(0) // nor on Chat
})

test('invite, join, buy with undo, and the admin sees it live', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice'))
  await createGroup(alice, 'Pub', 'Alice', [['Beer', '2.50']])
  const link = await createInvite(alice)

  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob'), 'Bob')
  await expect(bob.getByText('2 online')).toBeVisible()

  // undo within 8 seconds leaves no trace
  await bob.getByRole('button', { name: /Beer/ }).click()
  await expect(balance(bob)).toHaveText('-€2.50')
  await bob.getByRole('button', { name: 'Undo' }).click()
  await expect(balance(bob)).toHaveText('€0.00')

  // a real purchase reaches alice after the undo window
  await bob.getByRole('button', { name: /Beer/ }).click()
  const bobRow = alice.locator('.row', { hasText: 'Bob' }).first()
  await expect(bobRow).toContainText('-€2.50', { timeout: 15_000 })
  await alice.getByRole('button', { name: /^Log/ }).click() // collapsed until opened
  await expect(alice.locator('.row', { hasText: 'Bob joined' })).toBeVisible()
  // the single-use invite is used up
  await expect(alice.getByRole('button', { name: 'QR code' })).toHaveCount(0)
})

test('top-up and correction', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await login(page, email('topup'))
  await createGroup(page, 'Topup Pub', 'Tina', [['Water', '1']])
  await page.getByRole('link', { name: 'Tab' }).click()
  await expect(page.getByPlaceholder(/^Amount, e\.g\./)).toHaveCount(0) // hidden until asked for

  await page.getByRole('button', { name: /Top up/ }).click()
  await page.getByRole('button', { name: '+€10' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(balance(page)).toHaveText('€10.00')
  await expect(page.getByPlaceholder(/^Amount, e\.g\./)).toHaveCount(0) // closes after saving

  await page.getByRole('button', { name: /Top up/ }).click()
  await page.getByRole('button', { name: /Top up/ }).click() // toggles closed again
  await expect(page.getByPlaceholder(/^Amount, e\.g\./)).toHaveCount(0)
  await page.getByRole('button', { name: /Top up/ }).click()
  await page.getByPlaceholder(/^Amount, e\.g\./).fill('2,50')
  await page.getByRole('button', { name: 'Plus or minus' }).click() // keypads may lack a minus key
  await expect(page.getByPlaceholder(/^Amount, e\.g\./)).toHaveValue('-2,50')
  await page.getByPlaceholder('Note (optional)').fill('glass broken')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(balance(page)).toHaveText('€7.50')
  await expect(page.getByText('Correction: glass broken')).toHaveCount(0) // activity is collapsed
  await page.getByRole('button', { name: 'My activity' }).click()
  await expect(page.getByText('Correction: glass broken')).toBeVisible()
})

test('double tap or long press a product to book several at once', async ({ page }) => {
  await login(page, email('rounds'))
  await createGroup(page, 'Round Pub', 'Rita', [['Beer', '2.50']])
  await page.getByRole('link', { name: 'Tab' }).click()
  await expect(page.getByText('Double tap or hold to choose how many')).toBeVisible()
  const beer = page.getByRole('button', { name: /Beer/ })
  const dialog = page.getByRole('dialog')

  await beer.dblclick() // the first tap's booking is undone
  await dialog.getByRole('button', { name: 'One more' }).click()
  await dialog.getByRole('button', { name: 'One more' }).click()
  await dialog.getByRole('button', { name: 'Book €7.50' }).click()
  await expect(dialog).toBeHidden()
  await expect(balance(page)).toHaveText('-€7.50')
  await expect(page.getByText('3 × Beer · €7.50')).toBeVisible() // undo toast

  await beer.hover()
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
  await expect(dialog.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(balance(page)).toHaveText('-€7.50') // the long press booked nothing
})

test('a purchase made alone reaches a member who comes online later', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice3'))
  await createGroup(alice, 'Late Pub', 'Alice', [['Beer', '3']])
  const link = await createInvite(alice)
  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob3'), 'Bob')
  const groupUrl = alice.url()

  await alice.close() // alice's app is closed
  await expect(bob.getByText('1 online')).toBeVisible()
  await bob.getByRole('button', { name: /Beer/ }).click()
  await bob.getByRole('button', { name: 'My activity' }).click()
  await expect(bob.getByText('Just now')).toBeVisible()
  await expect(bob.getByText('Just now')).toBeHidden({ timeout: 15_000 }) // committed locally

  const aliceAgain = await alice.context().newPage() // same phone, app reopened
  await aliceAgain.goto(groupUrl)
  await expect(aliceAgain.locator('.row', { hasText: 'Bob' }).first()).toContainText('-€3.00', { timeout: 15_000 })
})

test('a member on a new phone gets the group back with an old, used invite link', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice8'))
  await createGroup(alice, 'Rejoin Pub', 'Alice', [['Beer', '2']])
  const link = await createInvite(alice) // single-use
  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob8'), 'Bob')
  await bob.getByRole('button', { name: /Beer/ }).click()
  await expect(alice.locator('.row', { hasText: 'Bob' }).first()).toContainText('-€2.00', { timeout: 15_000 })

  const bobsNewPhone = await phone(browser, baseURL!)
  await joinVia(bobsNewPhone, link, email('bob8'), 'Bob')
  await expect(balance(bobsNewPhone)).toHaveText('-€2.00')
})

test('an app in the background counts as offline at once, and online again when back', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice7'))
  await createGroup(alice, 'Presence Pub', 'Alice', [['Beer', '2']])
  const link = await createInvite(alice)
  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob7'), 'Bob')
  await expect(alice.getByText('2 online')).toBeVisible()

  await setVisibility(bob, 'hidden') // e.g. app switcher, screen locked, about to be killed
  await expect(alice.getByText('1 online')).toBeVisible({ timeout: 2_000 }) // only herself
  await expect(bob.getByText('Offline')).toBeVisible()
  await setVisibility(bob, 'visible')
  await expect(alice.getByText('2 online')).toBeVisible()
})

test('a member removed while online is told right away', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice4'))
  await createGroup(alice, 'Strict Pub', 'Alice', [])
  const link = await createInvite(alice)
  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob4'), 'Bob')

  await alice.locator('.row', { hasText: 'Bob' }).getByRole('button', { name: 'Remove' }).click()
  await expect(bob.getByText('You were removed from Strict Pub.')).toBeVisible({ timeout: 15_000 })
})

test('language switch and account deletion after leaving', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await login(page, email('leaver'))
  await createGroup(page, 'Short Pub', 'Lea', [])

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled()
  await page.getByLabel('Language').selectOption('de')
  await expect(page.getByRole('link', { name: 'Deckel' })).toBeVisible()
  await page.getByLabel('Sprache').selectOption('en')

  await page.getByRole('link', { name: 'Group', exact: true }).click()
  await page.getByRole('button', { name: 'Leave group' }).click()
  await expect(page.getByText('No groups yet')).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Delete account' }).click()
  await expect(page.getByText('Your account was deleted.')).toBeVisible()
})

test('group chat: live messages, delete own message', async ({ browser, baseURL }) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice5'))
  await createGroup(alice, 'Chat Pub', 'Alice', [])
  const link = await createInvite(alice)
  const bob = await phone(browser, baseURL!)
  await joinVia(bob, link, email('bob5'), 'Bob')

  await alice.getByRole('link', { name: 'Chat', exact: true }).click()
  await bob.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(bob.getByRole('heading', { name: 'Chat Pub' })).toBeVisible()
  await bob.getByPlaceholder('Message').fill('Who is coming tonight?')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(bob.getByText('Who is coming tonight?')).toBeVisible()
  await expect(alice.getByText('Who is coming tonight?')).toBeVisible({ timeout: 15_000 }) // live

  await expect(bob.getByRole('button', { name: 'Delete' })).toHaveCount(0) // no button: long press
  await bob.getByText('Who is coming tonight?').hover()
  await bob.mouse.down()
  await bob.waitForTimeout(700)
  await bob.mouse.up()
  await expect(alice.getByText('Who is coming tonight?')).toBeHidden({ timeout: 15_000 })
})

test('shows the app version and a note after an update', async ({ page }) => {
  const shown = deployedVersion().replace('+', ' (') + ')' // "0.9.0 (build.settings)"
  await login(page, email('versions'))
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByText('App version')).toBeVisible()
  await expect(page.locator('.row', { hasText: 'App version' })).toContainText(shown)

  await page.evaluate(() => localStorage.setItem('bardesk_version', '2.9.9+older'))
  await page.reload()
  await expect(page.getByText(`Updated to version ${shown}.`)).toBeVisible()
  await expect(page.getByText(`Updated to version ${shown}.`)).toBeHidden({ timeout: 8_000 }) // hides itself
  await page.reload()
  await expect(page.getByText('Updated to version')).toHaveCount(0) // only once
})

test('join by scanning the invite QR code inside the app', async ({ browser, baseURL }, testInfo) => {
  const alice = await phone(browser, baseURL!)
  await login(alice, email('alice6'))
  await createGroup(alice, 'Scan Pub', 'Alice', [['Beer', '3']])
  const link = await createInvite(alice)

  // bob's phone: its camera "sees" alice's QR code
  const video = testInfo.outputPath('invite.y4m')
  qrVideo(video, link)
  const camera = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  })
  try {
    const context = await camera.newContext({ ...devices['Pixel 7'], baseURL, permissions: ['camera'] })
    const bob = await context.newPage()
    await login(bob, email('bob6'))
    await bob.getByRole('button', { name: 'Join a group' }).click()
    await bob.getByRole('button', { name: 'Scan invite QR code' }).click()
    await expect(bob).toHaveURL(/\/join\//, { timeout: 15_000 })
    await bob.getByLabel('Your name in this group').fill('Bob')
    await bob.getByRole('button', { name: 'Join' }).click()
    await expect(bob.getByRole('button', { name: /Beer/ })).toBeVisible({ timeout: 15_000 })
  } finally {
    await camera.close()
  }
})

test('without camera access the scanner explains what to do instead of showing black', async ({ page }) => {
  await login(page, email('nocam')) // default context: no camera permission, no camera
  await page.getByRole('button', { name: 'Join a group' }).click()
  await page.getByRole('button', { name: 'Scan invite QR code' }).click()
  await expect(page.getByRole('heading', { name: /No camera (access|available)/ })).toBeVisible()
  await expect(page.getByText('paste the invite link')).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('button', { name: 'Scan invite QR code' })).toBeVisible()
})

test('login asks iPhone users to install the app first (with invite hint)', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], userAgent: devices['iPhone 15'].userAgent, baseURL })
  const page = await context.newPage()
  await page.goto('/join/8a843490-6569-49eb-b375-61522d36a94f?t=token')
  await expect(page.getByRole('heading', { name: 'Install the app first' })).toBeVisible()
  await expect(page.getByText('Add to Home Screen')).toBeVisible()
  await expect(page.getByText('scan the invite QR code on the Group tab')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)

  await page.getByRole('button', { name: 'Continue in the browser' }).click()
  await expect(page.getByLabel('Email')).toBeVisible()
  await context.close()
})

test('branding: name, legal link and light theme colours; screenshots of the look', async ({ browser, baseURL }, testInfo) => {
  const alice = await phone(browser, baseURL!)
  await alice.goto('/login')
  await expect(alice).toHaveTitle('Bardesk')
  await expect(alice.getByRole('heading', { name: 'Bardesk' })).toBeVisible()
  await expect(alice.getByRole('link', { name: 'Imprint' })).toHaveAttribute('href', 'https://example.org/imprint')
  const html = alice.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect(html).toHaveAttribute('style', /--color-primary: #d5121e/)

  await login(alice, email('look'))
  await createGroup(alice, 'Clubhouse', 'Alice', [
    ['Beer', '2.50'],
    ['Lemonade', '2.50'],
    ['Cola', '2'],
    ['Water', '1.50'],
  ])
  await alice.screenshot({ path: testInfo.outputPath('look-group.png') })
  await alice.getByRole('link', { name: 'Tab' }).click()
  await alice.getByRole('button', { name: /Beer/ }).click()
  await alice.getByRole('button', { name: /Top up/ }).click()
  await alice.screenshot({ path: testInfo.outputPath('look-tab.png') })
})

test('changed settings reach an open app, which keeps its database', async ({ page }) => {
  await login(page, email('settings'))
  await createGroup(page, 'Kept Pub', 'Alice', [['Beer', '3']])
  // the service worker serves the app from its precache now
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  try {
    render({ APP_NAME: 'Renamed Pub', THEME: 'dark', DB_NAME: 'other' })
    // the cached app starts, the relay asks for the new version (4005), the app updates itself
    await page.reload()
    await expect(page).toHaveTitle('Renamed Pub', { timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByText('This device keeps its data in the database "bardesk"')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Kept Pub' })).toBeVisible()
    await expect(page.getByText('1 online')).toBeVisible() // the relay lets the new version sync

    await page.context().setOffline(true) // starts offline with the new settings
    await page.reload()
    await expect(page).toHaveTitle('Renamed Pub')
    await expect(page.getByRole('heading', { name: 'Kept Pub' })).toBeVisible()
    await page.context().setOffline(false)
  } finally {
    render() // back to the settings of the other tests
  }
})

test('the menu bar stays at the very bottom and no page is wider than the screen', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await login(page, email('layout'))
  await createGroup(page, 'Layout Pub', 'Lou', [['Pils', '2.50']])
  const measure = () =>
    page.evaluate(() => {
      const nav = document.querySelector('nav')!.getBoundingClientRect()
      return {
        navBottom: Math.round(nav.bottom),
        navHeight: Math.round(nav.height),
        viewport: window.innerHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
      }
    })
  const results: Record<string, Awaited<ReturnType<typeof measure>>> = {}
  for (const tab of ['Tab', 'Chat', 'Group', 'Settings']) {
    await page.getByRole('link', { name: tab, exact: true }).click()
    await page.waitForTimeout(300)
    results[tab] = await measure()
  }
  console.log(JSON.stringify(results))
  for (const [tab, r] of Object.entries(results)) {
    expect(r.overflowX, `${tab} is wider than the screen`).toBe(0)
    expect(r.pageScrolls, `${tab}: only the content area may scroll, not the page`).toBe(false)
    expect(r.navBottom, `${tab}: menu bar not at the bottom`).toBe(r.viewport)
    expect(r.navHeight, `${tab}: menu bar height`).toBe(results.Settings.navHeight)
  }

  // chat: the message field stays at the bottom while scrolled up and grows with its text
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  const field = page.getByPlaceholder('Message')
  for (let i = 1; i <= 15; i++) {
    await field.fill(`Message ${i}`)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(field).toHaveValue('') // sent
  }
  await expect(page.getByText('Message 15')).toBeVisible()
  const composerGap = (scrollTop: number) =>
    page.evaluate((top) => {
      document.querySelector('main')!.scrollTo(0, top)
      return document.querySelector('nav')!.getBoundingClientRect().top - document.querySelector('main form')!.getBoundingClientRect().bottom
    }, scrollTop)
  // below 1 px: layout positions are fractional, a half pixel is not a visible gap
  expect(Math.abs(await composerGap(0))).toBeLessThan(1) // scrolled up: sticky right above the menu bar
  expect(Math.abs(await composerGap(1e6))).toBeLessThan(1) // at the newest message: no gap either
  const oneLine = (await field.boundingBox())!.height
  await field.fill('one\ntwo\nthree')
  expect((await field.boundingBox())!.height).toBeGreaterThan(oneLine)
  expect(await field.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16)

  // no accidental zoom: no double-tap zoom, and no form field small enough for iOS to zoom into
  await page.getByRole('link', { name: 'Group', exact: true }).click()
  await page.getByRole('button', { name: 'Create a group' }).click() // a card with form fields
  const zoom = await page.evaluate(() => ({
    // WebKit starts touch-action over at every scroll container, so each one needs it
    touchActions: [document.documentElement, ...document.querySelectorAll('*')]
      .filter((e) => e === document.documentElement || /auto|scroll/.test(getComputedStyle(e).overflow))
      .map((e) => getComputedStyle(e).touchAction),
    fields: document.querySelectorAll('input, select').length,
    smallFields: [...document.querySelectorAll('input, select')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length,
  }))
  expect(zoom.touchActions.length).toBeGreaterThan(1)
  expect(zoom.touchActions.every((a) => a === 'manipulation')).toBe(true)
  expect(zoom.fields).toBeGreaterThan(0)
  expect(zoom.smallFields).toBe(0)
})
