// 打卡表直接按格子读 —— 不经过识别模型, 快、读不断。
//
// 打卡机导出的表五花八门, 但都逃不出这几样:
//   ① 一行一次打卡 / 一行一天: 有「姓名」列、「日期」列, 时间在「时间」「上班」
//      「下班」「签到」之类的列里 (或者跟日期写在同一格 "2026-09-03 08:01");
//   ② 月报格子: 一行一个人, 1 号到 31 号排成一排, 每一格里是当天几次打卡的时
//      间 ("08:01 12:02 13:00 17:31", 常常是换行隔开);
//   ③ 跟②一样, 但人名写在格子上面那一行 ("姓名: 张三" / "姓名 | 张三")。
// 不管哪一种, 一个人一天里出现的所有 HH:MM, 第一个是上班, 最后一个是下班。
// 只有一个时间的那天算没打全, 不出。
//
// 纯函数, 读不出来返回空, 由调用方去走识别模型兜底。

type Cell = string | number | boolean | null
export type ParsedPunch = { name: string; dept?: string; day: number; in: string; out: string }

const TIME = /([01]?\d|2[0-3])[:：]([0-5]\d)/g

function str(c: Cell): string {
  return c === null || c === undefined ? '' : String(c).trim()
}

// Excel 的时间常常是一天里的小数 (0.3340 = 08:01)。
function timesIn(c: Cell): string[] {
  // 日期带时间的序号 (46268.334 = 那天 08:01) 也取小数那一截。
  const frac = typeof c === 'number' ? (c > 30000 ? c - Math.floor(c) : c) : 0
  if (typeof c === 'number' && frac > 0 && frac < 1) {
    const mins = Math.round(frac * 24 * 60)
    return [`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`]
  }
  const out: string[] = []
  for (const m of str(c).matchAll(TIME)) out.push(`${m[1].padStart(2, '0')}:${m[2]}`)
  return out
}

// 日期: "2026-09-03" / "2026/9/3" / "9月3日" / "09-03" / Excel 日期序号。
function dayOf(c: Cell, month: string): number | null {
  if (typeof c === 'number' && c > 30000 && c < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(c) * 86400000)
    const ym = d.toISOString().slice(0, 7)
    return ym === month ? d.getUTCDate() : null
  }
  const s = str(c)
  let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) {
    const ym = `${m[1]}-${m[2].padStart(2, '0')}`
    return ym === month ? Number(m[3]) : null
  }
  m = s.match(/^(\d{1,2})[-/.月](\d{1,2})/)
  if (m) return Number(m[1]) === Number(month.slice(5)) ? Number(m[2]) : null
  return null
}

function monthFrom(text: string): string | null {
  const m = text.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})/)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null
  return `${m[1]}-${m[2].padStart(2, '0')}`
}

/** 表上写的是哪个月 —— 标题、表名、文件名、日期列里找。 */
export function guessMonth(sheets: { name: string; aoa: Cell[][] }[], fileName: string): string | null {
  for (const s of sheets) {
    for (const row of s.aoa.slice(0, 6)) for (const c of row) {
      const m = monthFrom(str(c))
      if (m) return m
    }
  }
  return monthFrom(fileName) ?? sheets.map((s) => monthFrom(s.name)).find(Boolean) ?? null
}

const isNameHead = (s: string) => /^(姓名|员工姓名|名字|人员姓名)$/.test(s)
const isDeptHead = (s: string) => /^(部门|所属部门|部门名称)$/.test(s)
const isDateHead = (s: string) => /^(日期|考勤日期|打卡日期|日期时间|打卡时间)$/.test(s)
// 这些列里的 "9:30" 是时长 / 统计, 不是打卡时间。
const isHeadWord = (s: string) =>
  isNameHead(s) || isDeptHead(s) || isDateHead(s) || /上班|下班|签到|签退|时间|工号|序号|编号|职位/.test(s)
const isNotPunchHead = (s: string) => /时长|工时|迟到|早退|加班|缺勤|合计|小时|分钟/.test(s)

export function parsePunchSheets(
  sheets: { name: string; aoa: Cell[][] }[],
  month: string,
): ParsedPunch[] {
  // 姓名|几号 → 那天出现的所有时间
  const times = new Map<string, string[]>()
  const deptOf = new Map<string, string>()
  const add = (name: string, day: number, ts: string[]) => {
    if (!name || !(day >= 1 && day <= 31) || ts.length === 0) return
    const k = `${name}|${day}`
    times.set(k, [...(times.get(k) ?? []), ...ts])
  }

  for (const sheet of sheets) {
    const rows = sheet.aoa
    let nameCol = -1
    let deptCol = -1
    let dateCol = -1
    let dayCols: Map<number, number> | null = null // 列 → 几号
    let currentName = ''
    let currentDept = ''
    let skipCols = new Set<number>()

    for (const row of rows) {
      const cells = row.map(str)
      const ni = cells.findIndex(isNameHead)

      // 1 到 31 号那一排 (② ③ 的表头; ② 的姓名也在这一行)。
      const dayHits = new Map<number, number>()
      cells.forEach((c, i) => {
        const m = c.match(/^(\d{1,2})(日|号)?$/)
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) dayHits.set(i, Number(m[1]))
      })
      if (dayHits.size >= 20) {
        dayCols = dayHits
        if (ni >= 0) {
          nameCol = ni
          deptCol = cells.findIndex(isDeptHead)
        }
        continue
      }

      // 带「姓名」的一行: 是表头 (姓名 | 部门 | 日期 | 上班 | 下班), 还是 ③ 那种
      // 标签行 (姓名: 张三 / 工号 | 1 | 姓名 | 张三 | 部门 | 车间)。看「姓名」后
      // 面那一格: 也是个表头词就是表头, 是个名字就是标签行。
      const labelName = cells.map((c) => c.match(/^姓名[:：]\s*(\S+)/)?.[1]).find(Boolean)
      const next = ni >= 0 ? cells[ni + 1] : ''
      if (labelName || (ni >= 0 && next && !isHeadWord(next))) {
        currentName = labelName ?? next
        const di = cells.findIndex(isDeptHead)
        currentDept =
          cells.map((c) => c.match(/^部门[:：]\s*(\S+)/)?.[1]).find(Boolean) ??
          (di >= 0 ? (cells[di + 1] ?? '') : '')
        nameCol = -1
        deptCol = -1
        continue
      }
      if (ni >= 0) {
        nameCol = ni
        deptCol = cells.findIndex(isDeptHead)
        dateCol = cells.findIndex(isDateHead)
        skipCols = new Set(cells.flatMap((c, i) => (isNotPunchHead(c) ? [i] : [])))
        continue
      }

      const rowName = nameCol >= 0 ? cells[nameCol] : ''
      const name = rowName || currentName
      const dept = (deptCol >= 0 ? cells[deptCol] : '') || currentDept
      if (!name) continue
      if (dept) deptOf.set(name, dept)

      if (dayCols) {
        // ② ③: 每个几号的格子里取时间。
        for (const [col, day] of dayCols) add(name, day, timesIn(row[col] ?? null))
      } else if (dateCol >= 0) {
        // ①: 这一行是哪一天, 时间在这一行除了日期以外的格子里 (日期格里带着
        // 时间的也算)。
        const day = dayOf(row[dateCol] ?? null, month)
        if (!day) continue
        const ts: string[] = []
        row.forEach((c, i) => {
          if (i === nameCol || i === deptCol || skipCols.has(i)) return
          ts.push(...timesIn(c))
        })
        add(name, day, ts)
      }
    }
  }

  const out: ParsedPunch[] = []
  for (const [k, ts] of times) {
    const [name, d] = k.split('|')
    const uniq = [...new Set(ts)].sort()
    if (uniq.length < 2) continue
    out.push({ name, dept: deptOf.get(name), day: Number(d), in: uniq[0], out: uniq[uniq.length - 1] })
  }
  return out
}
