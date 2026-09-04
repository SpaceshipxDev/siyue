import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import {
  canSeeAllHr,
  canSeeDorm,
  hrDeptOf,
  requireHrUser,
} from '@/lib/auth'
import { getHrMonth, getHrYear } from '@/lib/hr'
import { getDormEntries } from '@/lib/dorm'
import { HR_TYPES, hrHasHours } from '@/lib/data'
import { today } from '@/lib/today'

// 考勤 / 住宿 → .xlsx. 导的就是屏幕上那一张表 —— 同一个月 (或同一年)、同一个
// 部门范围, 所以"导出"永远等于"我现在看到的这些"。
//
//   ?p=2026-09 / ?p=2026  考勤 — 汇总一人一行, 明细一笔一行
//   ?v=dorm               住宿 — 谁住哪一间
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  const user = await requireHrUser()
  const sp = request.nextUrl.searchParams

  const wb = XLSX.utils.book_new()
  let base: string

  if (sp.get('v') === 'dorm') {
    // 住宿是算在人身上的成本, 跟工资归同一档 — 页面看不到的人也导不走。
    if (!canSeeDorm(user)) return new Response('无权限', { status: 403 })

    const entries = await getDormEntries()
    const aoa: (string | number)[][] = [
      ['姓名', '部门', '宿舍号', '备注', '登记人'],
    ]
    for (const e of entries) {
      aoa.push([e.name, e.dept, e.room, e.note ?? '', e.by ?? ''])
    }
    addSheet(wb, aoa, [14, 12, 14, 30, 12], '住宿登记')
    base = `住宿登记_${today()}`
  } else {
    const raw = (sp.get('p') ?? '').trim()
    const period = /^\d{4}(-\d{2})?$/.test(raw) ? raw : today().slice(0, 7)
    const all = period.length === 4
      ? await getHrYear(period)
      : await getHrMonth(period)

    // 同一条部门边界: 看本部门的人, 导出来的也只有本部门。
    const seeAll = canSeeAllHr(user)
    const myDept = hrDeptOf(user)
    const records = seeAll
      ? all
      : all.filter((r) => (r.dept ?? '商务') === myDept)

    // 汇总 — 一人一行, 跟屏幕上那张表同样的口径。
    const by = new Map<string, typeof records>()
    for (const r of records) {
      const l = by.get(r.name) ?? []
      l.push(r)
      by.set(r.name, l)
    }
    const people = [...by.entries()]
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) =>
        a.list.length !== b.list.length
          ? b.list.length - a.list.length
          : a.name.localeCompare(b.name, 'zh'),
      )

    const sum: (string | number)[][] = [
      ['姓名', '部门', ...HR_TYPES, '请假共', '笔数'],
    ]
    for (const p of people) {
      const cells = HR_TYPES.map((t) => {
        const of = p.list.filter((r) => r.type === t)
        if (of.length === 0) return ''
        if (!hrHasHours(t)) return of.length
        const h = round1(of.reduce((s, r) => s + (r.hours ?? 0), 0))
        // 时长还没要求填的时候记下的线 — 只能读成笔数。
        return h > 0 ? h : `${of.length}次`
      })
      sum.push([
        p.name,
        p.list.find((r) => r.dept)?.dept ?? '',
        ...cells,
        round1(
          p.list
            .filter((r) => LEAVE.has(r.type))
            .reduce((s, r) => s + (r.hours ?? 0), 0),
        ),
        p.list.length,
      ])
    }
    addSheet(
      wb,
      sum,
      [14, 12, ...HR_TYPES.map(() => 9), 10, 8],
      '汇总',
    )

    // 明细 — 一笔一行, 按日期排, 用来对账。
    const detail: (string | number)[][] = [
      ['日期', '姓名', '部门', '类型', '时长', '说明', '记录人'],
    ]
    for (const r of [...records].sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'zh'),
    )) {
      detail.push([
        r.date,
        r.name,
        r.dept ?? '',
        r.type,
        hrHasHours(r.type) && r.hours ? round1(r.hours) : '',
        r.note ?? '',
        r.by ?? '',
      ])
    }
    addSheet(wb, detail, [12, 14, 12, 14, 8, 34, 12], '明细')

    base = `考勤_${period}`
  }

  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(`${base}.xlsx`)}`,
      'cache-control': 'no-store',
    },
  })
}

// 请假共 — 事假 + 病假 + 工伤, 跟屏幕上那一栏同一个口径 (旷工有时长, 但不是
// 请假)。
const LEAVE = new Set<string>(['事假', '病假', '工伤'])

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function addSheet(
  wb: XLSX.WorkBook,
  aoa: (string | number)[][],
  widths: number[],
  name: string,
): void {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = widths.map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(wb, ws, name)
}
