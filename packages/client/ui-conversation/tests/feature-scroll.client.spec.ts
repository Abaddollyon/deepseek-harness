// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bindFeatureScroll } from '../src/client/skeleton/feature-scroll.ts'

function fixture() {
  const shell = document.createElement('div')
  shell.dataset.conversationScroll = ''
  const area = document.createElement('div')
  const owner = document.createElement('div')
  owner.dataset.featureScroll = 'fixture'
  area.append(owner); shell.append(area)
  return { shell, area, owner }
}
function scroll(owner: HTMLElement, offset: number) {
  owner.scrollTop = offset
  owner.dispatchEvent(new Event('scroll'))
}

describe('feature scroll ownership', () => {
  it('starts at the top without inheriting Chat and restores only its scoped view', () => {
    const scope = {}
    const swarm = fixture()
    swarm.shell.scrollTop = 2400
    let unbind = bindFeatureScroll(swarm.area, scope, 'swarm')
    expect(swarm.shell.scrollTop).toBe(0)
    expect(swarm.owner.scrollTop).toBe(0)
    scroll(swarm.owner, 720); unbind()
    const tasks = fixture()
    unbind = bindFeatureScroll(tasks.area, scope, 'tasks')
    expect(tasks.owner.scrollTop).toBe(0)
    scroll(tasks.owner, 300); unbind()
    const returned = fixture()
    unbind = bindFeatureScroll(returned.area, scope, 'swarm')
    expect(returned.owner.scrollTop).toBe(720); unbind()
    unbind = bindFeatureScroll(returned.area, {}, 'swarm')
    expect(returned.owner.scrollTop).toBe(0); unbind()
  })

  it('ignores nested output scrollers and fences detached view events', () => {
    const scope = {}
    const { area, owner } = fixture()
    const nested = document.createElement('pre'); owner.append(nested)
    const unbind = bindFeatureScroll(area, scope, 'tasks')
    scroll(owner, 400); scroll(nested, 40); unbind(); scroll(owner, 900)
    const next = fixture()
    const dispose = bindFeatureScroll(next.area, scope, 'tasks')
    expect(next.owner.scrollTop).toBe(400); dispose()
  })

  it('waits for asynchronous content before restoring a clipped offset', async () => {
    const scope = {}
    const first = fixture()
    const off = bindFeatureScroll(first.area, scope, 'swarm')
    scroll(first.owner, 500); off()
    const next = fixture()
    let height = 0, top = 0
    Object.defineProperty(next.owner, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.min(height, value) } })
    const dispose = bindFeatureScroll(next.area, scope, 'swarm')
    expect(top).toBe(0)
    height = 1000
    next.owner.append(document.createElement('p'))
    await Promise.resolve()
    expect(top).toBe(500); dispose()
  })
})
