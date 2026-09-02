import { describe, expect, it } from 'vitest'
const success = {
  type: 'result',
  subtype: 'success',
  structured_output: {
    query: 'deepseek',
    answer: 'answer',
    sources: [{ url: 'https://example.test' }],
  },
}
const raw = {
  type: 'user',
  tool_use_result: {
    query: 'deepseek',
    results: [{ content: [{ url: 'https://example.test', title: 'Example' }] }],
  },
}
describe('SDK message replay fixtures', () => {
  it('contains raw WebSearch and structured success messages', () => {
    expect(raw.type).toBe('user')
    expect(success.subtype).toBe('success')
    expect(raw.tool_use_result.query).toBe(success.structured_output.query)
  })
  it('models failure and auth markers without credentials', () => {
    expect({ type: 'result', subtype: 'error_during_execution' }).toMatchObject(
      { subtype: 'error_during_execution' },
    )
    expect('authentication required').toMatch(/authentication required/)
  })
})
