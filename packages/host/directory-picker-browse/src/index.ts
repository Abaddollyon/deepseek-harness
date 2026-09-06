/** Browse picker interaction backed by the independent directory browser. */
import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type {} from '@deepseek-ai/dsh-host-directory-browser'

export default class BrowseDirectoryPicker extends DirectoryPicker {
  static inject = ['directoryBrowser']

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.ctx.directoryBrowser.list(path, signal),
    createDirectory: (path, name) => this.ctx.directoryBrowser.createDirectory(path, name),
  }

  capability(): DirectoryPickerCapability { return this.browseCapability }
}
