'use client';

import dynamic from 'next/dynamic';

/**
 * The diagnostics are a pure browser measurement: every value it shows comes
 * from `sessionStorage`, `performance`, `navigator` or a lifecycle event, none
 * of which exist while prerendering. Skipping SSR lets the component read that
 * state in `useState` initialisers instead of in an effect, so there is no
 * prerendered-then-corrected first paint to confuse a measurement.
 */
const TimerDiagnostics = dynamic(
  () => import('./timer-diagnostics').then((m) => m.TimerDiagnostics),
  {
    ssr: false,
    loading: () => <p className="p-6 text-sm text-muted">計測を初期化しています…</p>,
  },
);

export function DiagnosticsClient() {
  return <TimerDiagnostics />;
}
