import { describe, expect, test } from 'vitest'
import { apply } from '../src/index.ts'

describe('environment navigation host entry', () => {
  test('has no Host behavior', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
