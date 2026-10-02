/** Test package filling the Conversation aside and the `standard` preset's landing. */
window.__ModuleLoader__.load({
  id: '@fixture/conversation-seats',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.aside', () => ctx.slots.register({
          name: 'conversation.aside', id: 'fixture-aside',
        }, ({ agentPreset }) => React.createElement('aside', {
          'data-fixture-aside': agentPreset ?? '',
          style: { flex: 'none', boxSizing: 'border-box', width: '280px', borderLeft: '1px solid var(--dsw-alias-border-l3)' },
        }, 'Fixture aside')))
        ctx.slots.inject('conversation.landing', () => ctx.slots.register({
          name: 'conversation.landing', key: 'standard',
        }, ({ agentPreset }) => React.createElement('section', {
          'data-fixture-landing': agentPreset,
          style: { flex: '1', minHeight: '240px', padding: '24px' },
        }, 'Fixture landing')))
      },
    }
  },
})
