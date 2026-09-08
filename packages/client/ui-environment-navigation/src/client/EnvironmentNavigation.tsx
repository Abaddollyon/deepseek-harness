import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SidebarSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  AppLocation, EnvironmentSidebarMode,
} from '@deepseek-ai/dsh-client-environment-runtime/client'
import css from './EnvironmentNavigation.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Active full-content environment overview supplied by a Host catalog plugin. */
    'environment.overview.content': { kind: 'single'; scope: 'root' }
    /** Activity projection supplied by the active product bundle. */
    'sidebar.activity': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
  }
}

interface OverviewInjected {
  readonly hooks: { readonly environmentLocation: ObservableSnapshot<AppLocation> }
}

type OverviewProps = PropsRuntime<'active.content'>
  & PropsRenderSlots<'environment.overview.content'>
  & InjectFace<OverviewInjected>
  & PropsLocale<'environmentNavigation'>

/** Render the environment overview in the shell's active content layer. */
export function EnvironmentOverview(props: OverviewProps) {
  const location = props.useEnvironmentLocation(value => value)
  if (location.kind !== 'environments') return null
  return (
    <section className={css.overview} aria-label={props.t('overview.title')}>
      {props.renderSlot('environment.overview.content', {}, {
        fallback: (
          <div className={css.overviewFallback}>
            <h1>{props.t('overview.title')}</h1>
            <p>{props.t('overview.description')}</p>
            <div className={css.localHost}>{props.t('overview.local')}</div>
          </div>
        ),
      })}
    </section>
  )
}

interface ActivityInjected {
  readonly hooks: { readonly sidebarMode: ObservableSnapshot<EnvironmentSidebarMode> }
  setMode(mode: EnvironmentSidebarMode): void
}

type ActivityToggleProps = PropsRuntime<'sidebar.workspaces.header.action'>
  & InjectFace<ActivityInjected>
  & PropsLocale<'environmentNavigation'>

type ActivityContentProps = PropsRuntime<'sidebar.workspaces.content.overlay'>
  & PropsRenderSlots<'sidebar.activity'>
  & InjectFace<ActivityInjected>
  & PropsLocale<'environmentNavigation'>

function BellIcon() {
  return (
    <svg data-icon="bell" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  )
}

function ServerIcon() {
  return (
    <svg data-icon="server" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  )
}

/** Explicit Workspaces and Activity destinations in expanded and rail layouts. */
export function ActivityToggle(props: ActivityToggleProps) {
  const mode = props.useSidebarMode(value => value)
  return (
    <div className={css.modeTabs} data-wide={props.wide} role="group" aria-label={props.t('sidebar.mode')}>
      {(['workspaces', 'activity'] as const).map(destination => (
        <button
          key={destination}
          type="button"
          className={css.headerButton}
          aria-label={props.t(destination)}
          title={props.t(destination)}
          aria-pressed={mode === destination}
          onClick={() => {
            props.setMode(destination)
            if (!props.wide) props.expandSidebar()
          }}
        >
          {destination === 'activity' ? <BellIcon /> : <ServerIcon />}
          {props.wide && <span>{props.t(destination)}</span>}
        </button>
      ))}
    </div>
  )
}

/** Activity body occupying the existing Workspaces region when selected. */
export function ActivityContent(props: ActivityContentProps) {
  const mode = props.useSidebarMode(value => value)
  const owner = props
  useEffect(() => {
    owner.setUnderlyingHidden(mode === 'activity')
    return () => { owner.setUnderlyingHidden(false) }
  }, [mode, owner.setUnderlyingHidden])
  if (mode !== 'activity') return null
  return (
    <div className={css.activityContent}>
      {props.renderSlot('sidebar.activity', {
        wide: owner.wide,
        expandSidebar: owner.expandSidebar,
      })}
    </div>
  )
}

interface FooterInjected {
  openOverview(this: void): void
}

type FooterProps = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<FooterInjected>
  & PropsLocale<'environmentNavigation'>

/** Bottom server action that opens the in-app environment overview. */
export function EnvironmentFooterAction(props: FooterProps) {
  const owner = props
  return (
    <button type="button" className={`${css.footerButton} dsh-sidebar-footer-row ${owner.wide ? '' : css.railFooterButton}`} aria-label={props.t('environments')} onClick={props.openOverview}>
      <ServerIcon />
      {owner.wide && <span>{props.t('environments')}</span>}
    </button>
  )
}
