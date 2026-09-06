import { describe, expect, test } from 'vitest'
import { sessionKey } from '../src/client/identity.ts'

describe('environment session identity', () => {
  test('the same session id on two hosts has different identity', () => {
    expect(sessionKey({ environmentId: 'local', sessionId: 'same' }))
      .not.toBe(sessionKey({ environmentId: 'sigil', sessionId: 'same' }))
  })

  test('separators inside ids cannot collide', () => {
    expect(sessionKey({ environmentId: 'a:b', sessionId: 'c' }))
      .not.toBe(sessionKey({ environmentId: 'a', sessionId: 'b:c' }))
  })
})
