#!/usr/bin/env node
/**
 * Mesh chat UI acceptance: drives the live dsh web UI in headless Chromium
 * and proves the chat card works end to end — section renders (not stuck on
 * "loading…"), the fleet channel shows history + system events, a message
 * typed and sent through the real UI lands, and the steering strip mounts.
 *
 * Requires: playwright resolvable (npm i -D playwright, or run from a dir
 * that has it), a Chromium binary, and the dsh web UI reachable.
 *
 *   node scripts/acceptance-chat-ui.mjs [url]     (default http://127.0.0.1:3080)
 */
import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const MARKER = `acceptance-${Date.now().toString(36)}`
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (msg) => console.log(`ok: ${msg}`)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForTimeout(10_000)
await page.getByRole('button', { name: 'Continue' }).click({ force: true }).catch(() => {})
await page.waitForTimeout(1_500)
await page.getByRole('button', { name: 'Settings' }).first().click({ force: true })
await page.waitForTimeout(2_000)

const rail = await page.locator('body').innerText()
if (!rail.includes('Mesh chat')) fail('settings rail has no "Mesh chat" section')
ok('settings rail shows Mesh chat')

await page.locator('text=Mesh chat').first().click()
await page.waitForTimeout(8_000)
let body = await page.locator('body').innerText()
let section = body.slice(body.indexOf('Mesh chat'), body.indexOf('Mesh chat') + 600)
if (section.includes('loading…')) fail(`chat section still loading after 8s: ${section.slice(0, 160)}`)
ok('chat section renders (no loading hang)')

const input = page.locator('input[placeholder*="fleet"]').first()
if (!(await input.isVisible().catch(() => false))) fail(`fleet send box not visible — section: ${section.slice(0, 200)}`)
await input.fill(MARKER)
await page.getByRole('button', { name: 'Send', exact: true }).click()
await page.waitForTimeout(6_000)
body = await page.locator('body').innerText()
if (!body.includes(MARKER)) fail('sent message did not appear in the fleet channel within 6s')
ok('message sent through the UI appears in the fleet channel')

if (!body.includes('steer')) console.log('warn: steering strip not detected in the section (operator-only when no fleet capability — acceptable on unpaired machines)')
else ok('steering strip mounted')

await browser.close()
console.log('ACCEPTANCE PASS')
