'use client'

import { useMemo, useState } from 'react'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { visibleModules, type AdminModule } from '@/lib/permissions'

interface UseAdminModulesResult {
  /** Lenses this admin may switch between. Length 1 for a narrowed admin. */
  modules: AdminModule[]
  /**
   * The lens currently on screen. Always a member of `modules`.
   *
   * Named `activeModule` rather than the more natural `module` because callers
   * destructure it, and a bare `const { module }` trips Next's
   * no-assign-module-variable rule.
   */
  activeModule: AdminModule
  setModule: (module: AdminModule) => void
  /** True while the profile is still loading, so the scope isn't known yet. */
  loading: boolean
  /** Whether to render a switcher at all — false when there is nothing to pick. */
  hasChoice: boolean
}

/**
 * Which business lens a shared page (Dashboard, Maps, Reports) should render.
 *
 * The three pages every scope can reach need the same three things: the list of
 * lenses this admin is entitled to, which one is showing, and whether to offer a
 * switcher. Keeping that here means the pages agree with each other — a Sales
 * Admin can't end up on the sales dashboard but the collection map.
 *
 * `loading` matters more than it looks. Until the profile resolves, `role` is
 * null, and a null role is not an admin, so `visibleModules` reports the
 * unrestricted set. Rendering through that would flash all three tabs at a
 * Collection Admin before snapping to one. Callers should hold their content
 * until this clears rather than render against a scope that isn't known yet.
 */
export function useAdminModules(): UseAdminModulesResult {
  const { profile, loading } = useCurrentProfile()

  const modules = useMemo(
    () => visibleModules(profile?.role, profile?.admin_scope),
    [profile?.role, profile?.admin_scope]
  )

  const [selected, setSelected] = useState<AdminModule>(modules[0])

  // The profile arriving can invalidate the current pick — a Delivery Admin's
  // list resolves to ['delivery'] while `selected` still holds the 'sales'
  // default. Correct it during render (React's "adjusting state when a prop
  // changes" pattern, used the same way on the Maps page) so the page never
  // paints one frame of a lens this admin isn't entitled to.
  const activeModule = modules.includes(selected) ? selected : modules[0]
  if (activeModule !== selected) setSelected(activeModule)

  return {
    modules,
    activeModule,
    setModule: setSelected,
    loading,
    hasChoice: modules.length > 1,
  }
}
