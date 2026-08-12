'use client'

import { useRouter } from 'next/navigation'
import { UserX, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Web's counterpart to mobile's AccountSuspendedScreen (ADR-051).
 *
 * Deliberately separate from /unauthorized: that page explains a ROLE mismatch
 * and tells the reader to use the mobile app instead, which is actively
 * misleading for a deactivated superadmin — their role is fine and the mobile
 * app will turn them away too. Same wording as mobile's login block so an admin
 * fielding the call hears the same sentence from either app.
 */
export default function DeactivatedPage() {
  const router = useRouter()

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto">
          <UserX className="w-7 h-7 text-destructive" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">Account Deactivated</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This account has been deactivated. Contact your admin.
          </p>
        </div>

        <div className="bg-muted/30 border border-border rounded-xl p-4 text-left">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Your access to the Oracle Sales dashboard is suspended. Your work and records are
            unchanged — a super admin can reactivate the account at any time.
          </p>
        </div>

        <Button onClick={handleLogout} variant="outline" className="w-full h-10">
          <LogOut className="w-4 h-4 mr-2" />
          Log out
        </Button>
      </div>
    </div>
  )
}
