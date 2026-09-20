/** One primary directory plus explicitly selected sidepaths; never changes an existing Session. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

/** Folder draft owned by one mounted creation or editing interaction. */
export interface WorkspaceFoldersDialogProps {
  path: string
  additionalPaths: readonly string[]
  creating?: boolean
  flowAvailable: boolean
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  onSave: (additionalPaths: readonly string[]) => Promise<void>
  onClose: () => void
  t: WorkspacePickerProps['t']
}

/** Render an atomic folder editor using the Host's composed directory picker. */
export function WorkspaceFoldersDialog({
  path, additionalPaths, creating = false, flowAvailable, renderDirectoryFlow, onSave, onClose, t,
}: WorkspaceFoldersDialogProps) {
  const [paths, setPaths] = useState([...additionalPaths])
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const picker = useRef<AbortController | null>(null)
  const activePicker = picker.current
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; picker.current?.abort() }
  }, [])
  useEffect(() => {
    if (!flowAvailable) { picker.current?.abort(); setPicking(false) }
  }, [flowAvailable])
  const close = (): void => { if (!pending.current) onClose() }
  const save = async (): Promise<void> => {
    if (pending.current || picking) return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(paths)
      if (mounted.current) onClose()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  return <>
    <Modal
      open={!picking}
      onClose={close}
      closeLabel={t('close')}
      title={t(creating ? 'folders.create' : 'folders.edit')}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={saving} onClick={() => { void save() }}>{t(creating ? 'folders.create' : 'folders.save')}</Button>
      </>}
    >
      <div className={css.folders}>
        <strong>{t('folders.primary')}</strong>
        <div className={css.folderPath}>{path}</div>
        <p>{t('folders.scope')}</p>
        <strong>{t('folders.additional')}</strong>
        {paths.length === 0 && <p>{t('folders.empty')}</p>}
        <ul className={css.folderList}>
          {paths.map(folder => <li key={folder} className={css.folderRow}>
            <span className={css.folderPath}>{folder}</span>
            <Button variant="outline" disabled={saving} aria-label={t('folders.remove', { path: folder })} onClick={() => { setPaths(items => items.filter(item => item !== folder)) }}>{t('folders.removeLabel')}</Button>
          </li>)}
        </ul>
        <Button variant="outline" disabled={saving || !flowAvailable} onClick={() => {
          picker.current?.abort()
          picker.current = new AbortController()
          setError(null)
          setPicking(true)
        }}>{t('folders.add')}</Button>
        {!creating && <p>{t('folders.newSessions')}</p>}
        {error !== null && <div className={css.modalError} role="alert">{error}</div>}
      </div>
    </Modal>
    {renderDirectoryFlow({
      open: picking && flowAvailable,
      busy: false,
      onPicked: (folder) => {
        if (!mounted.current || !picking || !flowAvailable || activePicker === null || activePicker.signal.aborted) return
        activePicker.abort()
        setPaths(items => folder === path || items.includes(folder) ? items : [...items, folder])
        setPicking(false)
      },
      onCancel: () => {
        if (activePicker === null || activePicker.signal.aborted) return
        activePicker.abort()
        setPicking(false)
      },
      onError: (message) => {
        if (activePicker === null || activePicker.signal.aborted) return
        activePicker.abort()
        setPicking(false)
        setError(message)
      },
    })}
  </>
}
