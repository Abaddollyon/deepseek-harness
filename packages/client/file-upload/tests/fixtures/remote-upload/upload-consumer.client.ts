import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

export function createConsumerPlugin(capture: (ctx: Context) => void, receiptDisplay: ObservableSnapshot<string>) {
  return {
    inject: ['slots', 'environmentComposition', 'environmentNavigation', 'clientRuntimeActivator', 'fileUpload'],
    apply(ctx: Context) {
      capture(ctx)
      const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
      ctx.slots.installScope('session', {
        current: { getSnapshot: () => absent, subscribe: () => () => {} },
        resolve: () => undefined,
      })
      ctx.slots.register({ name: 'root', inject: () => ({ hooks: { receipt: receiptDisplay } }) },
        props => props.useReceipt(value => value))
    },
  }
}
