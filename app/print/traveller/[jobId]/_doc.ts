import type { Job } from '@/lib/data'

// One traveller sheet = one component. A single-part job's doc number is
// just the 单号; a multi-part job suffixes the part's 1-based position so
// the clerk can split the printed stack without ambiguity.
export function travellerDocNo(job: Job, index: number): string {
  if (job.components.length <= 1) return job.jobNo
  return `${job.jobNo}-${String(index + 1).padStart(2, '0')}`
}
