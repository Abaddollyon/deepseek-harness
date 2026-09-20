import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceController } from '../src/client/service.ts'
import type { WorkspaceView } from '../src/types.ts'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

const view: WorkspaceView = {
  workspaceId: 'w1' as never,
  path: '/work',
  title: 'work',
  additionalPaths: ['/side'],
  sessionIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failure = (operation: string): RemoteResult<never> => ({
  ok: false,
  error: new RemoteError('gateway/internal', operation + ' denied', {}),
})
const recovery = { retry: vi.fn(), snapshot: { getSnapshot: () => ({}), subscribe: () => () => {} } }

describe('WorkspaceController command boundaries', () => {
  it('forwards every successful command and exposes list/feed sources', async () => {
    const calls: string[] = []
    const model = {
      create: async () => { calls.push('create'); return ok({ workspace: view, created: true }) },
      updatePaths: async () => { calls.push('updatePaths'); return ok({ workspace: view }) },
      rename: async () => { calls.push('rename'); return ok({ workspace: view }) },
      delete: async () => { calls.push('delete'); return ok({ deleted: true }) },
      insertBefore: async () => { calls.push('insertBefore'); return ok({ workspaceIds: ['w1'] as never[] }) },
      archiveSession: async () => { calls.push('archiveSession'); return ok({ archivedSessionIds: ['s1'] as never[] }) },
      insertSessionBefore: async () => { calls.push('insertSessionBefore'); return ok({ workspace: view }) },
      getSnapshot: () => ({}) , subscribe: () => () => {},
    }
    const controller = new WorkspaceController(new Context(), model as never, recovery as never)
    expect(controller.list).toBe(model)
    expect(controller.feed).toBe(recovery.snapshot)
    await expect(controller.create({ path: '/work' })).resolves.toBe(view)
    await expect(controller.updatePaths('w1' as never, ['/side'])).resolves.toBe(view)
    await expect(controller.rename('w1' as never, 'renamed')).resolves.toBe(view)
    await expect(controller.delete('w1' as never)).resolves.toBeUndefined()
    await expect(controller.insertBefore('w1' as never)).resolves.toBeUndefined()
    await expect(controller.archiveSession('s1' as never)).resolves.toBeUndefined()
    await expect(controller.insertSessionBefore('w1' as never, 's1' as never)).resolves.toBe(view)
    expect(calls).toEqual(['create', 'updatePaths', 'rename', 'delete', 'insertBefore', 'archiveSession', 'insertSessionBefore'])
    controller.retryFeed()
    expect(recovery.retry).toHaveBeenCalledOnce()
  })

  it('turns every rejected command into a named actionable error', async () => {
    const model = Object.fromEntries([
      ['create', async () => failure('create')],
      ['updatePaths', async () => failure('update paths')],
      ['rename', async () => failure('rename')],
      ['delete', async () => failure('delete')],
      ['insertBefore', async () => failure('reorder')],
      ['archiveSession', async () => failure('session archive')],
      ['insertSessionBefore', async () => failure('move')],
    ])
    const controller = new WorkspaceController(new Context(), model as never, recovery as never)
    await expect(controller.create({ path: '/work' })).rejects.toThrow('workspace create failed')
    await expect(controller.updatePaths('w1' as never, [])).rejects.toThrow('workspace update paths failed')
    await expect(controller.rename('w1' as never, 'x')).rejects.toThrow('workspace rename failed')
    await expect(controller.delete('w1' as never)).rejects.toThrow('workspace delete failed')
    await expect(controller.insertBefore('w1' as never)).rejects.toThrow('workspace reorder failed')
    await expect(controller.archiveSession('s1' as never)).rejects.toThrow('workspace session archive failed')
    await expect(controller.insertSessionBefore('w1' as never, 's1' as never)).rejects.toThrow('workspace move failed')
  })
})
