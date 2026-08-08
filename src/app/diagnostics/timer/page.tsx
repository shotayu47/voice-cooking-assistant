import { DiagnosticsClient } from './diagnostics-client';

/**
 * Temporary measurement page for PHASE 6. It is intentionally not linked from
 * anywhere in the product UI and sits outside the `(app)` group, so it gets
 * neither the bottom navigation nor a place in the prefetch graph. Auth is the
 * existing proxy gate — `/diagnostics` is not in `PUBLIC_PATHS`, so no change
 * to the auth configuration was needed to keep it private.
 */
export const metadata = {
  title: '診断: タイマー | TSUGU',
  robots: { index: false, follow: false },
};

export default function TimerDiagnosticsPage() {
  return <DiagnosticsClient />;
}
