import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'WhatsApp Assistant',
  description: 'Setup and settings for your WhatsApp task assistant.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 16, maxWidth: 640 }}>{children}</body>
    </html>
  )
}
