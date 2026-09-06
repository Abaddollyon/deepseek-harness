/** Remote owner for always-addressable, display-free Host directory browsing. */
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DirectoryBrowserError } from '@deepseek-ai/dsh-host-directory-browser'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-browser'
import type {} from '@deepseek-ai/dsh-host-directory-browser'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const createRequest = z.object({ path: z.string(), name: z.string() }).refine(
  value => value.name.trim() !== '' && value.name !== '.' && value.name !== '..' && !/[/\\]/.test(value.name),
  { message: 'directoryBrowser.createDirectory requires a single non-blank path segment name' },
)

declare module '@deepseek-ai/cordis' {
  interface Context { directoryBrowserController: DirectoryBrowserController }
}

/** Host owner of the display-free `ctx.remote.directoryBrowser` namespace. */
export class DirectoryBrowserController extends TypertRemoteService {
  static inject = ['directoryBrowser']

  /** @param ctx - Host context carrying the always-available directory browser. */
  constructor(ctx: Context) { super(ctx, 'directoryBrowserController', { namespace: 'directoryBrowser' }) }

  /**
   * List one bounded directory level for an in-app client.
   * @param path - absolute directory to list; absent lists the provider root.
   * @param signal - caller lifetime used to cancel an in-progress scan.
   * @returns the directory entries and navigable ancestry.
   */
  @Remote('list')
  async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing> {
    try {
      return await this.ctx.directoryBrowser.list(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'directory listing was aborted', {}, { cause: error })
      throw browseFailure(error)
    }
  }

  /**
   * Create one child directory for an in-app client.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank child path segment.
   * @returns the created directory's canonical absolute path.
   */
  @Remote('createDirectory')
  async createDirectory(path: string, name: string): Promise<string> {
    const request = createRequest.safeParse({ path, name })
    if (!request.success) {
      throw new RemoteError('gateway/bad-request', 'invalid payload for directoryBrowser.createDirectory', { issues: request.error.issues })
    }
    try {
      return await this.ctx.directoryBrowser.createDirectory(request.data.path, request.data.name)
    } catch (error: unknown) {
      throw browseFailure(error)
    }
  }
}

function browseFailure(error: unknown): RemoteError {
  if (error instanceof DirectoryBrowserError) {
    const codes = {
      'directory-unreadable': 'directory-picker/unreadable',
      'directory-exists': 'directory-picker/exists',
      'directory-create-failed': 'directory-picker/create-failed',
    } as const
    return new RemoteError(codes[error.code], error.message, { path: error.path }, { cause: error })
  }
  return new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}, { cause: error })
}

export default DirectoryBrowserController
