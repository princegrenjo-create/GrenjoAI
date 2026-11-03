/**
 * The running-generations list, shared by both studios.
 *
 * One implementation because the two studios must behave identically here: the
 * same badge, the same indeterminate bar when a provider reports no percentage,
 * and the same cancel affordance. A copy in each page would drift the moment one
 * of them gained a state.
 */
import type { ReactElement } from 'react';
import type { GenerationJob } from '@shared/media';
import { Badge, Button, Progress } from '../ui';

export interface JobListProps {
  jobs: GenerationJob[];
  onCancel(job: GenerationJob): void;
  /** Optional per-job label override; defaults to the prompt. */
  label?(job: GenerationJob): string;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Generating',
};

export function JobList({ jobs, onCancel, label }: JobListProps): ReactElement | null {
  if (jobs.length === 0) return null;
  return (
    <ul className="pds-studio__jobs">
      {jobs.map((job) => {
        const text = label ? label(job) : job.prompt;
        return (
          <li key={job.id} className="pds-studio__job">
            <Badge tone="info" dot>
              {STATUS_LABEL[job.status] ?? job.status}
            </Badge>
            <span className="pds-studio__job-text">{text}</span>
            <Progress
              label={`Progress for: ${text}`}
              value={job.progress}
              valueText={job.progress === null ? 'Working…' : `${job.progress}%`}
            />
            <Button variant="ghost" size="sm" onClick={() => onCancel(job)}>
              Cancel
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
