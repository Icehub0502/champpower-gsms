import { fmtMins, slaOf } from '@champpower/domain';
import type { TodayJob } from '@gsms/contracts/index.js';
import { useNow } from './clock';

/**
 * The bottom-right line of a card. Only two honest sources exist today
 * (figma-80 brief, "Things this release must NOT fake"):
 *
 *   1. the SLA countdown, for a job with an estimate whose repair clock has
 *      started — computed by slaOf() from packages/domain, the same function
 *      the server counts "งานเกิน SLA" with, so the card and the pulse panel
 *      can never disagree about which cars are late;
 *   2. otherwise, how long the job has been in its current status.
 *
 * A job with no estimate shows no SLA. None is invented.
 */
export function CardTimer({ job }: { job: TodayJob }) {
  const t = useNow();

  const sla = job.sla
    ? slaOf(
        {
          status: job.status,
          repairStartedAt: job.sla.repairStartedAt,
          repairEndedAt: job.sla.repairEndedAt,
          // The contract already carries minutes; unit 'minute' is ×1.
          estValue: job.sla.estMinutes,
          estUnit: 'minute',
        },
        t,
      )
    : null;

  if (sla && sla.phase === 'late') {
    return <span className="kb-timer is-late">เกิน SLA · {sla.text}</span>;
  }
  if (sla && sla.phase === 'running') {
    return <span className="kb-timer">{sla.text}</span>;
  }

  const since = Date.parse(job.statusChangedAt);
  if (!Number.isFinite(since)) return null;
  const mins = Math.max(0, (t - since) / 60000);
  return <span className="kb-timer">{`${job.statusLabel} ${fmtMins(mins)}`}</span>;
}
