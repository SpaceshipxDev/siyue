// Shared contract between the job-detail page (server — stamps each part row)
// and the in-job part filter (client — reads it to hide/show rows). Kept out of
// any 'use client' file so both sides import the same source of truth.
//
// The page packs one char per stage (in STAGES order) into a single
// `<tr data-st="...">` attribute — e.g. "dddnipoppd" for 10 stages — so the
// client can filter by per-stage status without the server shipping a
// structured matrix. The char set mirrors effectiveStageState().kind.

export type PartStageKind =
  | 'pending'
  | 'in_progress'
  | 'outsourced'
  | 'done'
  | 'na'

export const PART_STAGE_CODE: Record<PartStageKind, string> = {
  pending: 'p',
  in_progress: 'i',
  outsourced: 'o',
  done: 'd',
  na: 'n',
}

// The buckets a viewer can filter on. 'na' is never a target — a part that
// skips a stage drops out of that column's filter, exactly as a job that skips
// a stage drops out of the master board's column filter. Order mirrors the
// work lifecycle so the menu reads top-down like the floor flows.
export type PartStageFilterKind = 'pending' | 'in_progress' | 'outsourced' | 'done'

export const PART_STAGE_FILTER_ORDER: PartStageFilterKind[] = [
  'pending',
  'in_progress',
  'outsourced',
  'done',
]

export const PART_STAGE_FILTER_LABEL: Record<PartStageFilterKind, string> = {
  pending: '未开始',
  in_progress: '进行中',
  outsourced: '外协',
  done: '已完成',
}
