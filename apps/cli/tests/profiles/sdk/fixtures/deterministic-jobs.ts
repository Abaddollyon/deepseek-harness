/** Deterministic job identities for the SDK diagnostic scenario; execution stays with the real registry. */
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

/** Assign instance-local fallback hints without replacing admission, storage, or execution. */
export default class DeterministicJobs extends LocalJobRegistry {
  private nextId = 0

  override start(spec: Parameters<LocalJobRegistry['start']>[0]): ReturnType<LocalJobRegistry['start']> {
    return super.start({ ...spec, idHint: spec.idHint ?? String(++this.nextId) })
  }
}
