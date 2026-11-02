// SPDX-License-Identifier: GPL-3.0-or-later
/** Helpers for the Playwright UI tests: devices (isolated browser contexts) and login. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { devices, expect, type Browser, type Page } from '@playwright/test'
import QRCode from 'qrcode'
import { UI_SETTINGS } from './settings'

const LOG = process.env.UI_LOG ?? ''
const run = Math.random().toString(36).slice(2, 8)

/** Run the render step on the served app again, with `changes` to the UI_SETTINGS. */
export function render(changes: Record<string, string> = {}): void {
  execFileSync('./venv/bin/python', ['-m', 'app.render', process.env.UI_DIST!], {
    cwd: join(import.meta.dirname, '../../backend'),
    env: { ...process.env, ...UI_SETTINGS, ...changes },
  })
}

/** The deployed app version (version.json, written by the render step). */
export function deployedVersion(): string {
  return JSON.parse(readFileSync(join(process.env.UI_DIST!, 'version.json'), 'utf8')).version
}

/** Unique email per test run, so tests never share accounts. */
export function email(name: string): string {
  return `${name}-${run}@example.com`
}

/** A separate phone: own browser context = own IndexedDB and device key. */
export async function phone(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL })
  const page = await context.newPage()
  page.on('dialog', (dialog) => dialog.accept()) // confirm() prompts
  return page
}

async function loginCode(address: string, logOffset: number): Promise<string> {
  let code = ''
  await expect
    .poll(() => {
      const match = readFileSync(LOG, 'utf8')
        .slice(logOffset)
        .match(new RegExp(`Login code for ${address.replace(/[.+]/g, '\\$&')}: (\\d{6})`))
      code = match?.[1] ?? ''
      return code
    })
    .not.toBe('')
  return code
}

/** Log in on the current page (starting at the login screen or any protected route). */
export async function login(page: Page, address: string): Promise<void> {
  if (!page.url().includes('/login')) await page.goto('/login')
  const offset = readFileSync(LOG, 'utf8').length
  const inBrowser = page.getByRole('button', { name: 'Continue in the browser' })
  await expect(page.getByLabel('Email').or(inBrowser)).toBeVisible()
  if (await inBrowser.isVisible()) await inBrowser.click() // tests run in the browser, not installed
  await page.getByLabel('Email').fill(address)
  await page.getByRole('button', { name: 'Send login code' }).click()
  await expect(page).toHaveURL(/\/verify/)
  await page.getByLabel('Login code').fill(await loginCode(address, offset)) // auto-submits
  await expect(page).not.toHaveURL(/\/verify/)
}

/** Create a group with products; ends on the group's management page. */
export async function createGroup(page: Page, name: string, myName: string, products: [string, string][]): Promise<void> {
  await page.goto('/group')
  await page.getByRole('button', { name: 'Create a group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByLabel('Your name in this group').fill(myName)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  if (products.length) await page.getByRole('button', { name: /^Products/ }).click() // collapsed
  for (const [product, price] of products) {
    await page.getByPlaceholder('Product').fill(product)
    await page.getByPlaceholder('2.50').fill(price)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('.row', { hasText: product }).first()).toBeVisible()
  }
}

/** Create an invite on the group page and return its link (from the QR code). */
export async function createInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: /^Invites/ }).click() // collapsed
  await page.getByRole('button', { name: 'Create invite link' }).click()
  const qrButton = page.getByRole('button', { name: 'QR code' }).first()
  await expect(qrButton).toBeVisible()
  await expect(page.locator('img[alt*="/join/"]')).toHaveCount(0) // only on request
  await qrButton.click()
  const qr = page.getByRole('dialog').locator('img[alt*="/join/"]') // in the foreground
  await expect(qr).toBeVisible()
  const link = (await qr.getAttribute('alt'))!
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  return link
}

/** Open an invite link on a fresh phone, log in and join. Ends on the Tab. */
export async function joinVia(page: Page, link: string, address: string, myName: string): Promise<void> {
  await page.goto(new URL(link).pathname + new URL(link).search)
  await expect(page).toHaveURL(/\/login\?redirect=/) // not logged in yet: back here after login
  await login(page, address)
  await page.getByLabel('Your name in this group').fill(myName)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
}

export const balance = (page: Page) => page.locator('.balance').first()

/** Headless Chromium never hides a page: send the app to the background and back. */
export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/**
 * Write a Y4M video showing `text` as a QR code, for Chromium's fake camera
 * (--use-file-for-fake-video-capture). Grayscale: Y = pixels, U/V = neutral.
 */
export function qrVideo(path: string, text: string, size = 480): void {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const scale = Math.floor(size / (modules.size + 8))
  const offset = Math.floor((size - modules.size * scale) / 2)
  const y = Buffer.alloc(size * size, 255)
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue
      for (let dy = 0; dy < scale; dy++) {
        y.fill(0, (offset + row * scale + dy) * size + offset + col * scale, (offset + row * scale + dy) * size + offset + (col + 1) * scale)
      }
    }
  }
  const chroma = Buffer.alloc((size / 2) * (size / 2) * 2, 128)
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma])
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${size} H${size} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]))
}
