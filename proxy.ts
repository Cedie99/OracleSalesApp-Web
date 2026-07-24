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
  const isProtected = !isAuthPage && !isUnauthorizedPage && pathname !== '/'

  if (!user && isProtected) {
    return redirectTo('/login')
  }

  if (user && isAuthPage) {
    return redirectTo('/dashboard')
  }

  if (user && isProtected) {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role, admin_scope')
      .eq('user_id', user.id)
      .single()

    // A failed lookup must not read as "no role" — that would bounce a valid
    // admin to /unauthorized. The one realistic cause is an environment where
    // migration 024 hasn't run, so admin_scope doesn't exist and PostgREST
    // rejects the whole select; fall back to the pre-024 shape rather than
    // locking the app's own administrators out of it.
    let role = profile?.role as UserRole | undefined
    let scope = profile?.admin_scope as AdminScope | undefined
    if (error) {
      const { data: fallback } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', user.id)
        .single()
      role = fallback?.role as UserRole | undefined
      scope = 'all'
    }

    if (!hasWebAccess(role)) {
      return redirectTo('/unauthorized')
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
