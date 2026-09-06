import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  EnvironmentId, EnvironmentNavigationService, EnvironmentSidebarMode,
} from '@deepseek-ai/dsh-client-environment-runtime/client'
import {
  ActivityContent, ActivityToggle, EnvironmentFooterAction, EnvironmentOverview,
} from './EnvironmentNavigation.tsx'
import { en, zh, type EnvironmentNavigationKey } from './locales.ts'

export type { EnvironmentNavigationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Environment navigation and Activity copy. */
    environmentNavigation: EnvironmentNavigationKey
  }
}

/** Required shell services. */
export const inject = ['slots', 'locale', 'uiSidebar', 'environmentNavigation']

/**
 * Install persistent-shell navigation and presentation state.
 * @param ctx - shell Cordis root.
 */
export function apply(ctx: Context): void {
  const navigation = ctx.environmentNavigation as EnvironmentNavigationService
  const presentation = navigation.presentation
  ctx.effect(
    () => ctx.locale.register('environmentNavigation', { zh, en }),
    'ui-environment-navigation: dictionaries',
  )
  const activeEnvironment = (): EnvironmentId => {
    const location = navigation.getSnapshot()
    return location.kind === 'session' ? location.ref.environmentId : location.selectedId ?? 'local'
  }
  let sidebarMode = presentation.getSidebarMode(activeEnvironment())
  const modeListeners = new Set<() => void>()
  const publishMode = (): void => {
    const next = presentation.getSidebarMode(activeEnvironment())
    if (next === sidebarMode) return
    sidebarMode = next
    for (const listener of [...modeListeners]) listener()
  }
  const modeSource: ObservableSnapshot<EnvironmentSidebarMode> = {
    getSnapshot: () => sidebarMode,
    subscribe(listener) {
      modeListeners.add(listener)
      return () => { modeListeners.delete(listener) }
    },
  }
  ctx.effect(() => {
    const offNavigation = navigation.subscribe(publishMode)
    const offPresentation = presentation.subscribe(publishMode)
    return () => {
      offPresentation()
      offNavigation()
      modeListeners.clear()
    }
  }, 'ui-environment-navigation: active sidebar mode')

  ctx.effect(() => ctx.slots.register({
    name: 'active.content',
    id: 'environment-overview',
    locale: 'environmentNavigation',
    children: { 'environment.overview.content': { kind: 'single', scope: 'root' } },
    inject: () => ({ hooks: { environmentLocation: navigation } }),
  }, EnvironmentOverview), 'ui-environment-navigation: overview')

  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.workspaces.header.action',
    id: 'environment-activity-toggle',
    order: -100,
    locale: 'environmentNavigation',
    inject: () => ({
      sidebarMode: modeSource,
      setMode: (mode: EnvironmentSidebarMode) => {
        presentation.setSidebarMode(activeEnvironment(), mode)
      },
    }),
  }, ActivityToggle), 'ui-environment-navigation: Activity toggle')

  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.workspaces.content.overlay',
    locale: 'environmentNavigation',
    children: { 'sidebar.activity': { kind: 'single', scope: 'root' } },
    inject: () => ({
      sidebarMode: modeSource,
      setMode: (mode: EnvironmentSidebarMode) => {
        presentation.setSidebarMode(activeEnvironment(), mode)
      },
    }),
  }, ActivityContent), 'ui-environment-navigation: Activity content')

  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'environments',
    order: -100,
    locale: 'environmentNavigation',
    inject: () => ({
      openOverview: () => { navigation.open({ kind: 'environments', selectedId: activeEnvironment() }) },
    }),
  }, EnvironmentFooterAction), 'ui-environment-navigation: overview action')
}
