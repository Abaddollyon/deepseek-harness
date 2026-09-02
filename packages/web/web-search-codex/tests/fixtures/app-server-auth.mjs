#!/usr/bin/env node
process.env.DSH_REPLAY_CODEX_AUTH = '1'
await import('./app-server.mjs')
