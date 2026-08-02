import type { Metadata } from "next"
import { DM_Sans } from "next/font/google"
import "./globals.css"
import { Toaster } from "@/components/ui/sonner"

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "SalesApp Admin",
  description: "Sales Client Meeting Admin Panel",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        {/* Pinned light on purpose: sonner.tsx falls back to theme="system", and
            the app has no ThemeProvider, so an OS-dark user would otherwise get a
            dark toast over a light app. Remove this pin only alongside a real
            theme toggle. */}
        <Toaster richColors theme="light" />
      </body>
    </html>
  )
}
