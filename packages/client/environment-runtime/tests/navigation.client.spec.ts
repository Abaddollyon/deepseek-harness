import { describe, expect, test, vi } from 'vitest'
import {
  createEnvironmentNavigation,
  environmentSelection,
  type AppLocation,
} from '../src/client/navigation.ts'

const local: AppLocation = {
  kind: 'session',
  ref: { environmentId: 'local', sessionId: 'same' },
  viewId: 'chat',
}
const remote: AppLocation = {
  kind: 'session',
  ref: { environmentId: 'sigil', sessionId: 'same' },
  viewId: 'activity',
}

describe('environment navigation', () => {
  test('back restores the prior Host, Session, and view', () => {
    const navigation = createEnvironmentNavigation(local)
    const changed = vi.fn()
    navigation.subscribe(changed)

    navigation.open(remote)
    navigation.open({ kind: 'environments', selectedId: 'sigil' })
    navigation.back()
    expect(navigation.getSnapshot()).toEqual(remote)
    navigation.back()
    expect(navigation.getSnapshot()).toEqual(local)
    expect(changed).toHaveBeenCalledTimes(4)
  })

  test('copies locations so caller mutation cannot change navigation state', () => {
    const mutable = {
      kind: 'session' as const,
      ref: { environmentId: 'local', sessionId: 'one' },
      viewId: 'chat',
    }
    const navigation = createEnvironmentNavigation(mutable)
    mutable.ref.sessionId = 'changed'

    expect(navigation.getSnapshot()).toEqual({
      kind: 'session',
      ref: { environmentId: 'local', sessionId: 'one' },
      viewId: 'chat',
    })
  })

  test('a rejected pending open leaves the active location unchanged', async () => {
    const navigation = createEnvironmentNavigation(local)

    await expect(navigation.openWhen(
      Promise.reject(new Error('offline')),
      remote,
    )).rejects.toThrow('offline')

    expect(navigation.getSnapshot()).toEqual(local)
  })

  test('a late readiness result cannot overwrite newer navigation intent', async () => {
    const navigation = createEnvironmentNavigation(local)
    let ready!: () => void
    const pending = new Promise<void>((resolve) => { ready = resolve })
    const stale = navigation.openWhen(pending, remote)
    navigation.open({ kind: 'environments', selectedId: 'sigil' })
    ready()
    await stale
    expect(navigation.getSnapshot()).toEqual({ kind: 'environments', selectedId: 'sigil' })
  })

  test('projects an owning Host only after navigation opens one of its Sessions', () => {
    const navigation = createEnvironmentNavigation(local)
    const selected = environmentSelection(navigation)
    const changes = vi.fn()
    selected.subscribe(changes)

    expect(selected.getSnapshot()).toBe('local')
    navigation.open({ kind: 'environments', selectedId: 'sigil' })
    expect(selected.getSnapshot()).toBeUndefined()
    navigation.open(remote)
    expect(selected.getSnapshot()).toBe('sigil')
    expect(changes).toHaveBeenCalledTimes(2)
  })
})

test('returns to the most recent conversation across multiple overview visits, including blank content', () => {
  const navigation = createEnvironmentNavigation({ kind: 'new-session', environmentId: 'sigil', viewId: 'chat' })
  navigation.open({ kind: 'environments', selectedId: 'sigil' })
  navigation.open({ kind: 'environments', selectedId: 'local' })
  navigation.backToSession()
  expect(navigation.getSnapshot()).toEqual({ kind: 'new-session', environmentId: 'sigil', viewId: 'chat' })
  expect(environmentSelection(navigation).getSnapshot()).toBe('sigil')
})
