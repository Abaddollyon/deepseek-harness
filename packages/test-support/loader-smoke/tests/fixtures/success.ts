/** Successful subprocess fixture for the Loader-smoke harness. */

import { readdirSync } from 'node:fs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => { input += chunk })
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    configPath: process.argv[2],
    args: process.argv.slice(2),
    cwd: process.cwd(),
    dshHome: process.env.DSH_HOME,
    agentsHome: process.env.DSH_AGENTS_HOME,
    marker: process.env.LOADER_SMOKE_MARKER,
    ambientDsh: process.env.DSH_LOADER_SMOKE_AMBIENT ?? null,
    entries: readdirSync(process.cwd()).sort(),
    input,
  }))
  console.error('fixture stderr')
})
