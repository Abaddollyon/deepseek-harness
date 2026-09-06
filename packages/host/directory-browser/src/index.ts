/** Always-addressable Host directory browsing capability for in-app clients. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
export { DirectoryPickerError as DirectoryBrowserError } from '@deepseek-ai/dsh-host-directory-picker'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Bounded filesystem browsing primitives which never open Host UI. */
    directoryBrowser: DirectoryBrowser
  }
}

/** Independent browsing seam used by remote and in-app Workspace pickers. */
export abstract class DirectoryBrowser extends Service {
  /** @param ctx - Host context that will expose this browser as `ctx.directoryBrowser`. */
  constructor(ctx: Context) { super(ctx, 'directoryBrowser') }
  /**
   * List one bounded directory level without opening operating-system UI.
   * @param path - absolute directory to list; absent lists the provider root.
   * @param signal - caller lifetime used to cancel an in-progress scan.
   * @returns the directory entries and navigable ancestry.
   */
  abstract list(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create one child directory below an existing parent.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank child path segment.
   * @returns the created directory's canonical absolute path.
   */
  abstract createDirectory(path: string, name: string): Promise<string>
}

export default DirectoryBrowser
