import { STAGES, type Stage } from './data'

// 报工统计里按工段看的那一排按钮。打磨、丝印合成一个「打磨·丝印」(于海伟
// 2026-10-15): 打磨喷漆那个账号三道都报, 算钱时要分成 打磨丝印 一块、喷漆
// 一块 —— 喷漆本来就有自己的按钮。报工本身照旧一道一道记, 只是看的时候合。

export const REPORT_GROUPS = {
  '打磨·丝印': ['打磨', '丝印'],
} as const satisfies Record<string, readonly Stage[]>

export type ReportView = Stage | keyof typeof REPORT_GROUPS

/** 按钮的顺序 —— 跟工段一样, 打磨那个位置换成「打磨·丝印」, 丝印不再单列。 */
export const REPORT_VIEWS: ReportView[] = STAGES.flatMap((s): ReportView[] =>
  s === '打磨' ? ['打磨·丝印'] : s === '丝印' ? [] : [s],
)

export function isReportView(v: unknown): v is ReportView {
  return (
    typeof v === 'string' &&
    ((STAGES as readonly string[]).includes(v) || Object.hasOwn(REPORT_GROUPS, v))
  )
}

/** 这个按钮包含哪几道工段。 */
export function stagesOfView(v: ReportView): Stage[] {
  return Object.hasOwn(REPORT_GROUPS, v)
    ? [...REPORT_GROUPS[v as keyof typeof REPORT_GROUPS]]
    : [v as Stage]
}
