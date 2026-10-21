/**
 * Audit U-7 (L-10): the app's own pages, in one list for every menu that leads to them — the
 * settings gear (D338), the workspace "…" menu's ACE section (D331) and the phone bar's menu
 * (FR-MOB-001) — so they cannot drift apart again. Guardrails, Tools, Usage and Help used to be
 * reachable only from inside a workflow. `id` names each menu's test id (`menu-<id>`,
 * `settings-menu-<id>`). The first-run wizard is "Setup wizard": it sets up a provider, a template
 * and a first run, and can be opened again at any time.
 */
export const APP_LINKS = [
  { to: '/providers', label: 'Providers', id: 'providers' },
  { to: '/settings', label: 'Settings', id: 'settings' },
  { to: '/usage', label: 'Usage', id: 'usage' },
  { to: '/guardrails', label: 'Guardrail policies', id: 'guardrails' },
  { to: '/library/tools', label: 'Tools', id: 'tools' },
  { to: '/bench', label: 'Bench', id: 'bench' },
  { to: '/onboarding', label: 'Setup wizard', id: 'onboarding' },
  { to: '/help/getting-started', label: 'Help', id: 'help' },
] as const;
