export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const TODAY_ROUTE = '/today'
export const SETTINGS_ROUTE = '/settings'
export const COMMAND_CENTER_ROUTE = '/command-center'
export const SKILLS_ROUTE = '/skills'
export const MESSAGING_ROUTE = '/messaging'
export const ARTIFACTS_ROUTE = '/artifacts'
export const STUDY_ROUTE = '/study'
export const LIBRARY_ROUTE = '/library'
export const GRAPH_ROUTE = '/graph'
export const RECORDER_ROUTE = '/recorder'
export const CALENDAR_ROUTE = '/calendar'
export const CRON_ROUTE = '/cron'
export const PROFILES_ROUTE = '/profiles'
export const AGENTS_ROUTE = '/agents'
export const STARMAP_ROUTE = '/starmap'

export type AppView =
  | 'agents'
  | 'artifacts'
  | 'calendar'
  | 'chat'
  | 'command-center'
  | 'cron'
  | 'graph'
  | 'library'
  | 'messaging'
  | 'profiles'
  | 'recorder'
  | 'settings'
  | 'skills'
  | 'starmap'
  | 'study'
  | 'today'

export type AppRouteId =
  | 'agents'
  | 'artifacts'
  | 'calendar'
  | 'command-center'
  | 'cron'
  | 'graph'
  | 'library'
  | 'messaging'
  | 'new'
  | 'profiles'
  | 'recorder'
  | 'settings'
  | 'skills'
  | 'starmap'
  | 'study'
  | 'today'

export interface AppRoute {
  id: AppRouteId
  path: string
  view: AppView
}

export const APP_ROUTES = [
  { id: 'new', path: NEW_CHAT_ROUTE, view: 'chat' },
  { id: 'today', path: TODAY_ROUTE, view: 'today' },
  { id: 'settings', path: SETTINGS_ROUTE, view: 'settings' },
  { id: 'command-center', path: COMMAND_CENTER_ROUTE, view: 'command-center' },
  { id: 'skills', path: SKILLS_ROUTE, view: 'skills' },
  { id: 'messaging', path: MESSAGING_ROUTE, view: 'messaging' },
  { id: 'artifacts', path: ARTIFACTS_ROUTE, view: 'artifacts' },
  { id: 'study', path: STUDY_ROUTE, view: 'study' },
  { id: 'library', path: LIBRARY_ROUTE, view: 'library' },
  { id: 'graph', path: GRAPH_ROUTE, view: 'graph' },
  { id: 'recorder', path: RECORDER_ROUTE, view: 'recorder' },
  { id: 'calendar', path: CALENDAR_ROUTE, view: 'calendar' },
  { id: 'cron', path: CRON_ROUTE, view: 'cron' },
  { id: 'profiles', path: PROFILES_ROUTE, view: 'profiles' },
  { id: 'agents', path: AGENTS_ROUTE, view: 'agents' },
  { id: 'starmap', path: STARMAP_ROUTE, view: 'starmap' }
] as const satisfies readonly AppRoute[]

const APP_VIEW_BY_PATH = new Map<string, AppView>(APP_ROUTES.map(route => [route.path, route.view]))
const RESERVED_PATHS: ReadonlySet<string> = new Set(APP_ROUTES.map(route => route.path))

// Views that render as a full-screen modal card (OverlayView) over the shell.
// While one is open the app's titlebar control clusters must hide so they don't
// bleed over the overlay (they sit at a higher z-index than the overlay card).
export const OVERLAY_VIEWS: ReadonlySet<AppView> = new Set([
  'agents',
  'command-center',
  'cron',
  'profiles',
  'settings',
  'starmap'
])

export function isOverlayView(view: AppView): boolean {
  return OVERLAY_VIEWS.has(view)
}

export function isNewChatRoute(pathname: string): boolean {
  return pathname === NEW_CHAT_ROUTE
}

export function routeSessionId(pathname: string): string | null {
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX) || RESERVED_PATHS.has(pathname)) {
    return null
  }

  const id = pathname.slice(SESSION_ROUTE_PREFIX.length)

  return id && !id.includes('/') ? decodeURIComponent(id) : null
}

export function sessionRoute(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
}

export function appViewForPath(pathname: string): AppView {
  if (isNewChatRoute(pathname) || routeSessionId(pathname)) {
    return 'chat'
  }

  return APP_VIEW_BY_PATH.get(pathname) ?? 'chat'
}
