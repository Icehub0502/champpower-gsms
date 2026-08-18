import type { Job, Vehicle } from '@champpower/domain';
import { PlateBadge } from '../ui/PlateBadge';
import { StatusLabel, StatusTrack } from './StatusTrack';

interface JobCardProps {
  job: Job;
  vehicle: Vehicle | undefined;
  onClick: (jobId: string) => void;
}

export function JobCard({ job, vehicle, onClick }: JobCardProps) {
  return (
    <button className="job-card" onClick={() => onClick(job.id)}>
      <div className="job-card-top">
        <PlateBadge plate={vehicle?.plate} province={vehicle?.province} />
        <StatusLabel status={job.status} />
      </div>
      <div className="job-card-model">
        {vehicle ? `${vehicle.brand} ${vehicle.model}` : 'ไม่ทราบรุ่นรถ'}
      </div>
      <StatusTrack status={job.status} />
      <div className="job-card-meta">
        <span>{job.jobNumber}</span>
        {job.bay && <span className="job-card-bay">{job.bay}</span>}
        {job.technician && <span>{job.technician}</span>}
      </div>
    </button>
  );
}
