/**
 * Manage-folders dialog: edits one Workspace's additional directories with the
 * composed directory flow, then saves the complete list in one Host call.
 * Sessions keep the roots they recorded; only new Sessions use the saved list.
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

/** Inputs owned by the Workspace browser for one open dialog. */
export interface WorkspaceFoldersDialogProps {
  /** Primary Workspace directory, shown read-only. */
  path: string
  /** Additional directories when the dialog opened. */
  additionalPaths: readonly string[]
  /** Whether the directory-flow hole is occupied. */
  flowAvailable: boolean
  /** Render the directory-flow hole with this dialog as its owner. */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** Persist the complete list; a rejection's message is shown in the dialog. */
  onSave: (additionalPaths: readonly string[]) => Promise<void>
  /** Dismiss the dialog. */
  onClose: () => void
  /** The Workspace locale seat. */
  t: WorkspacePickerProps['t']
}

/**
 * Render the folder list editor and its directory flow.
 * @param props - dialog inputs.
 * @returns the dialog and the flow hole.
 */
export function WorkspaceFoldersDialog({
  path, additionalPaths, flowAvailable, renderDirectoryFlow, onSave, onClose, t,
}: WorkspaceFoldersDialogProps) {
  const [paths, setPaths] = useState<readonly string[]>(additionalPaths)
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A flow occupant that unloads mid-pick leaves nobody to answer; show the dialog again.
  useEffect(() => {
    if (picking && !flowAvailable) setPicking(false)
  }, [picking, flowAvailable])

  const save = (): void => {
    setSaving(true)
    setError(null)
    onSave(paths).then(onClose, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSaving(false)
    })
  }
  const close = (): void => { if (!saving) onClose() }

  return (
    <>
      <Modal
        open={!picking}
        onClose={close}
        closeLabel={t('close')}
        title={t('folders.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={saving} onClick={close}>{t('cancel')}</Button>
            <Button variant="primary" className={css.modalAction} disabled={saving} onClick={save}>{t('folders.save')}</Button>
          </>
        )}
      >
        <div className={css.folders}>
          <div className={css.folderLabel}>{t('folders.primary')}</div>
          <div className={css.folderPath}>{path}</div>
          <div className={css.folderLabel}>{t('folders.additional')}</div>
          {paths.length === 0 && <div className={css.folderHint}>{t('folders.empty')}</div>}
          {paths.length > 0 && (
            <ul className={css.folderList}>
              {paths.map(folder => (
                <li key={folder} className={css.folderRow}>
                  <span className={css.folderPath}>{folder}</span>
                  <Button
                    variant="outline"
                    disabled={saving}
                    aria-label={t('folders.remove', { path: folder })}
                    onClick={() => { setPaths(items => items.filter(item => item !== folder)) }}
                  >
                    {t('folders.removeLabel')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="outline" disabled={saving || !flowAvailable} onClick={() => { setError(null); setPicking(true) }}>
              {t('folders.add')}
            </Button>
          </div>
          <div className={css.folderHint}>{t('folders.newSessions')}</div>
          {error !== null && <div className={css.modalError} role="alert">{error}</div>}
        </div>
      </Modal>
      {renderDirectoryFlow({
        open: picking && flowAvailable,
        busy: false,
        onPicked: (folder) => {
          setPicking(false)
          setPaths(items => folder === path || items.includes(folder) ? items : [...items, folder])
        },
        onCancel: () => { setPicking(false) },
        onError: (message) => {
          setPicking(false)
          setError(message)
        },
      })}
    </>
  )
}
