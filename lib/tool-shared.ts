// 工具领用 —— 员工从厂里领走的刀具、量具、扳手…… 谁、哪天、领了什么、几件。
//
//   人事记领用 → 按人累计 (领了多少、还没还多少) → 离职那天对一遍: 还回来的
//   勾掉, 没还的按价钱扣款 → 扣款进那个月的工资条「工具扣款」
//
// 以前这件事靠一本登记簿, 人走的时候没人想起来翻, 工具就跟着人走了。这里一
// 个人一摞, 离职时点一下就知道还差什么。(于海伟 2026-10-23)
//
// 纯类型 + 纯函数 —— 服务端和客户端共用。存取在 lib/tool.ts。

export type ToolIssue = {
  id: string
  name: string // 领用人
  date: string // 领用日期 YYYY-MM-DD
  tool: string // 工具名称
  qty: number
  /** 单价 —— 没还要扣款时按它算; 领的时候不知道可以空着, 扣款时再填。 */
  priceCny?: number
  note?: string
  by: string // 谁记的
  createdAt: string
  /** 还回来了 */
  returnedAt?: string // YYYY-MM-DD
  returnedBy?: string
  /** 没还, 扣款了 —— 扣在哪个月的工资里 */
  deductCny?: number
  deductMonth?: string // YYYY-MM
  deductedBy?: string
}

export type ToolState = 'out' | 'returned' | 'deducted'

export function toolState(t: ToolIssue): ToolState {
  if (t.returnedAt) return 'returned'
  if (t.deductMonth) return 'deducted'
  return 'out'
}

export const TOOL_STATE_LABEL: Record<ToolState, string> = {
  out: '未归还',
  returned: '已归还',
  deducted: '已扣款',
}

/** 一件工具值多少 —— 单价 × 件数, 没定价就是 undefined。 */
export function toolValue(t: { qty: number; priceCny?: number }): number | undefined {
  return typeof t.priceCny === 'number' ? Math.round(t.priceCny * t.qty * 100) / 100 : undefined
}

/** 每个人这个月工资里该扣的工具款 —— 离职确认时没还、扣在这个月的那几件。 */
export function toolDueByName(issues: ToolIssue[], month: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of issues) {
    if (t.deductMonth !== month || !t.deductCny) continue
    out[t.name] = Math.round(((out[t.name] ?? 0) + t.deductCny) * 100) / 100
  }
  return out
}
