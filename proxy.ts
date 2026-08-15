import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { adminScope, canAccessRoute, hasWebAccess, homeRouteForScope } from '@/lib/permissions'
import type { AdminScope, UserRole } from '@/types'

export async function proxy(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || supabaseUrl === 'your-supabase-project-url' || !supabaseKey) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  /**
   * Redirect that PRESERVES the auth cookies.
   *
   * getUser() above silently rotates an expiring access/refresh token pair, and
   * supabase-ssr hands the new pair to setAll(), which writes it onto
   * `supabaseResponse`. Returning a bare NextResponse.redirect() throws that
   * response — and the only copy of the rotated tokens — away, while Supabase
   * has already invalidated the old refresh token server-side. The session is
   * then unrecoverable and every later request bounces to /login, which reads
   * exactly like "I can't log in any more".
   *
   * Every redirect out of this proxy must go through here.
   */
  function redirectTo(path: string) {
    const response = NextResponse.redirect(new URL(path, request.url))
    supabaseResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie))
    return response
  }

  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname
  const isAuthPage = pathname.startsWith('/login')
  const isUnauthorizedPage = pathname.startsWith('/unauthorized')
  // Exempt for the same reason as /unauthorized: it is the destination of a
  // redirect made from inside this proxy, so treating it as protected would
  // bounce it straight back to itself.
  const isDeactivatedPage = pathname.startsWith('/deactivated')
  const isProtected = !isAuthPage && !isUnauthorizedPage && !isDeactivatedPage && pathname !== '/'

  if (!user && isProtected) {
    return redirectTo('/login')
  }

  if (user && isAuthPage) {
    return redirectTo('/dashboard')
  }

  if (user && isProtected) {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role, admin_scope, is_active')
      .eq('user_id', user.id)
      .single()

    // A failed lookup must not read as "no role" — that would bounce a valid
    // admin to /unauthorized. The one realistic cause is an environment where
    // migration 024 hasn't run, so admin_scope doesn't exist and PostgREST
    // rejects the whole select; fall back to the pre-024 shape rather than
    // locking the app's own administrators out of it.
    let role = profile?.role as UserRole | undefined
    let scope = profile?.admin_scope as AdminScope | undefined
    let isActive = profile?.is_active as boolean | undefined
    if (error) {
      const { data: fallback } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('user_id', user.id)
        .single()
      role = fallback?.role as UserRole | undefined
      scope = 'all'
      isActive = fallback?.is_active as boolean | undefined
    }

    if (!hasWebAccess(role)) {
      return redirectTo('/unauthorized')
    }

    // Checked AFTER the role gate on purpose: a deactivated mobile role is told
    // the stabler fact ("this role uses the mobile app"), and the mobile app
    // then turns them away for being deactivated.
    //
    // Strict `=== false` so the check fails OPEN. is_active has existed since
    // migration 002 and the select above is the same one that already worked,
    // but a null or absent value must never lock an administrator out of the
    // app that administers it — the same reasoning as the error fallback above.
    if (isActive === false) {
      return redirectTo('/deactivated')
    }

    // Scoped admins (migration 024) are steered back to their own function
    // rather than shown /unauthorized — they are authorised web users, just not
    // for this page, and typing a URL shouldn't look like an access failure.
    if (!canAccessRoute(role, scope, pathname)) {
      return redirectTo(homeRouteForScope(adminScope(role, scope)))
    }
  }

  return supabaseResponse
}

export const config = {
  // `api/` is excluded here because API routes authenticate themselves (see
  // lib/cron-secret.ts for the cron routes) — this proxy only guards pages,
  // and Vercel Cron's bearer-token requests carry no Supabase session cookie
  // for it to check anyway.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
