// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { DirectoryFlowOwnerProps } from '../src/client/contract/slots.ts'
import { WorkspaceFoldersDialog, type WorkspaceFoldersDialogProps } from '../src/client/WorkspaceFoldersDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
function mount(overrides: Partial<WorkspaceFoldersDialogProps> = {}) {
  let flow: DirectoryFlowOwnerProps
  const props: WorkspaceFoldersDialogProps = {
    path: '/main', additionalPaths: ['/side'], flowAvailable: true,
    renderDirectoryFlow: (owner) => { flow = owner; return owner.open ? <div data-testid="picker" /> : null },
    onSave: vi.fn(async () => {}), onClose: vi.fn(), t: makeTranslate(en, commonEn), ...overrides,
  }
  const view = render(<WorkspaceFoldersDialog {...props} />)
  return {
    props, view, flow: () => flow,
    rerender: (patch: Partial<WorkspaceFoldersDialogProps>) => {
      Object.assign(props, patch)
      view.rerender(<WorkspaceFoldersDialog {...props} />)
    },
  }
}

describe('Workspace folders draft', () => {
  it('adds and removes sidepaths without mutating the primary folder or duplicate entries', async () => {
    const b = mount()
    for (const folder of ['/main', '/side', '/second']) {
      fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
      act(() => { b.flow().onPicked(folder) })
    }
    expect(screen.getAllByText('/side')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /side' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    await waitFor(() => { expect(b.props.onClose).toHaveBeenCalledOnce() })
    expect(b.props.onSave).toHaveBeenCalledWith(['/second'])
    expect(screen.getByText('/main')).toBeTruthy()
  })

  it('cancels a draft without a write and explains existing Session ownership', () => {
    const b = mount()
    expect(screen.getByText(en['folders.newSessions'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(b.props.onClose).toHaveBeenCalledOnce()
    expect(b.props.onSave).not.toHaveBeenCalled()
  })

  it('retains the draft on picker cancellation/failure and service unload', () => {
    const b = mount()
    act(() => { b.flow().onCancel(); b.flow().onError('not open') })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    const cancelled = b.flow()
    act(() => { cancelled.onCancel(); cancelled.onCancel(); cancelled.onError('cancelled') })
    expect(screen.getByText('/side')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    const stale = b.flow()
    act(() => { b.flow().onError('unavailable') })
    expect(screen.getByRole('alert').textContent).toBe('unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    b.rerender({ flowAvailable: false })
    expect(screen.queryByTestId('picker')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add folder' }).disabled).toBe(true)
    act(() => { stale.onPicked('/late'); b.flow().onPicked('/late') })
    expect(screen.queryByText('/late')).toBeNull()
    b.rerender({ flowAvailable: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add folder' }).disabled).toBe(false)
    b.view.unmount()
    act(() => { stale.onPicked('/after-disposal') })
    expect(b.props.onSave).not.toHaveBeenCalled()
  })

  it('retains a rejected draft, then retries once while ignoring duplicate save/close gestures', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const save = vi.fn<WorkspaceFoldersDialogProps['onSave']>().mockRejectedValueOnce('denied').mockReturnValue(pending)
    const b = mount({ onSave: save })
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    expect(b.props.onClose).not.toHaveBeenCalled()
    const submit = screen.getByRole('button', { name: 'Save folders' })
    act(() => { fireEvent.click(submit); fireEvent.click(submit) })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(save).toHaveBeenCalledTimes(2)
    expect(b.props.onClose).not.toHaveBeenCalled()
    await act(async () => { resolve(); await pending })
    expect(b.props.onClose).toHaveBeenCalledOnce()
  })

  it('retains a draft rejected with an Error and ignores success after disposal', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const save = vi.fn<WorkspaceFoldersDialogProps['onSave']>()
      .mockRejectedValueOnce(new Error('invalid directory')).mockReturnValue(pending)
    const b = mount({ onSave: save })
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('invalid directory') })
    expect(screen.getByText('/side')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    b.view.unmount()
    await act(async () => { resolve(); await pending })
    expect(b.props.onClose).not.toHaveBeenCalled()
  })

  it('does not navigate or display an error after disposal during an asynchronous save', async () => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_, fail) => { reject = fail })
    const b = mount({ onSave: () => pending })
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    b.view.unmount()
    await act(async () => { reject(new Error('late failure')); await pending.catch(() => {}) })
    expect(b.props.onClose).not.toHaveBeenCalled()
  })
})
