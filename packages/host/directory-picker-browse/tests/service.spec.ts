/** Compatibility projection from the independent browser seam to DirectoryPicker browse capability. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectoryBrowser } from '@deepseek-ai/dsh-host-directory-browser'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-browser'
import BrowseDirectoryPicker from '../src/index.ts'

class StubDirectoryBrowser extends DirectoryBrowser {
  readonly calls: string[] = []

  list(path = '/home/test'): Promise<DirectoryListing> {
    this.calls.push(`list:${path}`)
    return Promise.resolve({ path, home: '/home/test', crumbs: [], entries: [], truncated: false })
  }

  createDirectory(path: string, name: string): Promise<string> {
    this.calls.push(`create:${path}:${name}`)
    return Promise.resolve(`${path}/${name}`)
  }
}

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

describe('BrowseDirectoryPicker', () => {
  it('projects the independent browser through the legacy browse capability', async () => {
    const ctx = new Context()
    const browserFiber = ctx.plugin(StubDirectoryBrowser)
    const pickerFiber = ctx.plugin(BrowseDirectoryPicker)
    disposals.push(() => ctx.fiber.dispose())
    await Promise.all([browserFiber.await(), pickerFiber.await()])

    const browser = ctx.get('directoryBrowser') as StubDirectoryBrowser
    const capability = ctx.get('directoryPicker')!.capability()
    expect(capability.kind).toBe('browse')
    if (capability.kind !== 'browse') throw new Error('expected browse capability')
    await expect(capability.list('/work')).resolves.toMatchObject({ path: '/work' })
    await expect(capability.createDirectory('/work', 'child')).resolves.toBe('/work/child')
    expect(browser.calls).toEqual(['list:/work', 'create:/work:child'])
  })
})
