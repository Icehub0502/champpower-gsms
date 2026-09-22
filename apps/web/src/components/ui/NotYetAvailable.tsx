/**
 * WO-004/T6: the API only mounts /health, /api/auth, /api/admin, and the
 * intake routers (queue/bookings/checkin) — see apps/api/src/app.ts. Every
 * screen below still calls the old MySQL-era endpoints (/api/jobs/api/config
 * and friends for finance/catalog/warranty/ai/etc.), which are simply not
 * mounted, so calling them would 404 or (for a page that polls) spin forever.
 *
 * Rather than let each of those pages fail open in its own way, every route
 * for a not-yet-ported screen renders this instead, and each is also removed
 * from AppShell's sidebar (components/AppShell.tsx) so nobody lands here by
 * clicking a live-looking link — only by a direct URL. The underlying page
 * component is kept on disk and unported deliberately (do not delete): a
 * later phase ports it against @gsms/contracts + the real endpoints.
 */
export function NotYetAvailable({ title }: { title: string }) {
  return (
    <div className="empty-state" role="status">
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{title}</h2>
      <p className="page-sub" style={{ margin: 0 }}>
        ยังไม่เปิดใช้งานในเวอร์ชันนี้
      </p>
    </div>
  );
}
