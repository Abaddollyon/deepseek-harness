import { describe, expect, test } from 'vitest'
import { createEnvironmentPresentationStore } from '../src/client/presentation-state.ts'

describe('environment presentation state', () => {
  test('keeps same-named Session drafts and selections separate by Host', () => {
    const store = createEnvironmentPresentationStore()
    const local = { environmentId: 'local', sessionId: 'same' }
    const remote = { environmentId: 'sigil', sessionId: 'same' }

    store.update(local, { draft: 'local draft', viewId: 'chat', scrollAnchor: 'turn-7' })
    store.update(remote, { draft: 'remote draft', viewId: 'activity', detailId: 'child-2' })

    expect(store.get(local)).toMatchObject({ draft: 'local draft', viewId: 'chat', scrollAnchor: 'turn-7' })
    expect(store.get(remote)).toMatchObject({ draft: 'remote draft', viewId: 'activity', detailId: 'child-2' })
  })

  test('round-trips bounded state across remount without persisting authority', () => {
    const first = createEnvironmentPresentationStore()
    const ref = { environmentId: 'sigil', sessionId: 'one' }
    first.update(ref, { draft: 'continue here', viewId: 'work', detailId: 'task-3', scrollAnchor: 'row-9' })
    first.setSidebarMode('sigil', 'activity')

    const serialized = first.serialize()
    const restored = createEnvironmentPresentationStore(serialized)

    expect(restored.get(ref)).toEqual(first.get(ref))
    expect(restored.getSidebarMode('sigil')).toBe('activity')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('credential')
  })

  test('ignores malformed persisted state', () => {
    const store = createEnvironmentPresentationStore('{"sessions":{"bad":null}}')
    expect(store.get({ environmentId: 'local', sessionId: 'one' })).toEqual({
      draft: '',
      viewId: 'chat',
    })
    expect(store.getSidebarMode('local')).toBe('workspaces')
  })
})
