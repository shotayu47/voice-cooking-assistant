import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'TSUGU',
  description: '冷蔵庫の中身を知っている料理の相棒',
  applicationName: 'TSUGU',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TSUGU',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays enabled: blocking it fails WCAG 1.4.4, and iOS Safari
  // ignores maximum-scale anyway. Accidental double-tap advancement is
  // prevented in the step handler instead, where it can be done precisely.
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className="h-full">
      <body className="min-h-full bg-bg text-fg">{children}</body>
    </html>
  );
}
