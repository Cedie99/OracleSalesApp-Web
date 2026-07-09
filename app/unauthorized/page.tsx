'use client'

import { useRouter } from 'next/navigation'
import { ShieldAlert, Smartphone, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export default function UnauthorizedPage() {
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
          <ShieldAlert className="w-7 h-7 text-destructive" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">Access Restricted</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your account role doesn&apos;t have access to this part of the Oracle Sales web dashboard.
          </p>
        </div>

        <div className="flex items-start gap-3 bg-muted/30 border border-border rounded-xl p-4 text-left">
          <Smartphone className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Sales Specialist, RSR, and Collector accounts use the Oracle Sales <span className="text-foreground font-medium">mobile app</span> instead
            of this web dashboard. If you believe this is a mistake, contact your admin.
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
