// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The headless client (e.g. a bar station) as a container: `register` creates its key pair
 * once, `run` keeps it online.
 * Settings (environment): BOT_DIR (data folder), BOT_RELAY_URL (required for `run`), BOT_NAME, BOT_JOIN_LINK,
 * BOT_UNDO_MS (default 0), BOT_API_TOKEN (turns the local network API on, see api.ts), BOT_API_PORT (default 8080).
 */
import 'fake-indexeddb/auto' // before anything loads Dexie
import { WebSocketRelay } from '../core/relay'
import { startApi } from './api'
import { startBot } from './bot'
import { createIdentity } from './identity'

const dir = process.env.BOT_DIR ?? './data'
const displayName = process.env.BOT_NAME ?? 'Bar station'
const [command, ...args] = process.argv.slice(2)

async function register(email: string): Promise<void> {
  const publicKey = await createIdentity(dir, email)
  const values = `'${email.toLowerCase()}', '${publicKey}'`
  console.log(`Created ${dir}/identity.json (keep it secret).

Register the account once in the server's database (DATABASE_URL, default bardesk.db):

  INSERT INTO account (email, public_key) VALUES (${values});

With the Docker setup, run this in the folder with docker-compose.yaml:

  docker compose exec app python -c "import sqlite3; c = sqlite3.connect('/data/bardesk.db'); c.execute('INSERT INTO account (email, public_key) VALUES (?, ?)', (${values})); c.commit()"
`)
}

async function run(): Promise<void> {
  const relayUrl = process.env.BOT_RELAY_URL
  if (!relayUrl) {
    console.error('BOT_RELAY_URL is not set: the relay of your server, e.g. wss://tab.example.org/api/ws')
    process.exit(2)
  }
  const bot = await startBot({
    dir,
    displayName,
    joinLink: process.env.BOT_JOIN_LINK,
    saveEveryMs: 10_000,
    undoMs: Number(process.env.BOT_UNDO_MS ?? 0), // bookings sync at once; > 0 keeps them undoable that long first
    connect: (identity, _publicKey, handlers) =>
      new WebSocketRelay(relayUrl, identity.email, identity.keyPair.privateKey, {
        ...handlers,
        status: (status) => {
          console.log(`relay: ${status}`)
          handlers.status(status)
        },
      }),
    onFatal: (status) => {
      console.error(`stopped: ${status} (outdated = rebuild the bot from the deployed version)`)
      void bot.stop().finally(() => process.exit(75))
    },
  })
  const token = process.env.BOT_API_TOKEN
  if (token) {
    const port = Number(process.env.BOT_API_PORT ?? 8080)
    await startApi({ client: bot.client, token, port })
    console.log(`API on port ${port}`)
  }
  const stop = () => void bot.stop().finally(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  console.log(`bot ${bot.client.email} started, groups: ${bot.client.visibleGroups().length}`)
}

if (command === 'register') {
  const email = args[0] ?? 'bot'
  register(email).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
} else if (command === 'run') {
  run().catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  console.error('usage: bot register [email] | bot run')
  process.exit(2)
}
