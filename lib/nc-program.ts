/*
 * 程序单 — 一个零件在机台上要调哪几个程序。
 *
 * 刀路是在 UG 里做的, 这里不做刀路, 也不生成 G 代码 —— 那是编程员和他那台
 * 电脑的事。系统要接的是刀路做完之后断掉的那一截:
 *
 *   编程员做完程序, 存进车间的共享盘。操机走到机台前, 不知道调哪个程序、用
 *   哪几把刀、怎么装夹 —— 只能回头喊一声。喊得到就等几分钟, 喊不到就停在那。
 *   同一个件半年后再来一次, 谁也不记得上回编过, 于是从头再编一遍。
 *
 * 所以程序单上只有操机在机台前要知道的那几件事: 调哪个程序号、上哪台机、怎
 * 么装夹、备哪几把刀、一件大概几分钟。加上一个签名 —— 程序是谁出的, 机台上
 * 撞了刀要找谁, 不用问第二个人。
 *
 * 一个零件可以有好几条 (粗加工一条、精加工一条、第二次装夹再一条), 按建的
 * 先后排 —— 那就是机台上要跑的顺序。
 *
 * 纯类型和纯判断 ⇒ 服务端和客户端都能 import。读写在 lib/nc-program-store.ts。
 */

export type NcProgram = {
  id: string
  jobId: string
  /** 挂在哪个零件上 (工单里的 componentId) */
  componentId: string
  /**
   * 这是"哪一个件" —— 料号优先, 没料号用零件名 (见 reuseKey)。componentId 每
   * 张工单都是新的, 认不出"同一个件"; 半年后同一个件再来, 靠的是这个钥匙。
   */
  partKey?: string
  /** 程序号 — 机台上调的那个名字, O1001 / 35.003-4.NC */
  no: string
  /** 上哪台机 — 850 / 加工中心3号 / 走心机, 厂里怎么叫就怎么填 */
  machine?: string
  /** 装夹 · 工位 — 平口钳 / 四轴 / 二次装夹翻面 */
  fixture?: string
  /** 刀具 — 一行字, 编程员自己的写法: D8R1 · D6 · T3钻 */
  tools?: string
  /** 单件预计分钟 — 排产和报工都用得上 */
  minutes?: number
  note?: string
  by?: string
  createdAt: string
}

export type NcProgramPatch = {
  no?: string
  machine?: string
  fixture?: string
  tools?: string
  minutes?: number
  note?: string
}

/** 一条程序读成一行字 — 零件行上的 title、看板上的提示都用这一句。 */
export function programLine(p: NcProgram): string {
  return [
    p.no,
    p.machine,
    p.fixture,
    p.tools,
    typeof p.minutes === 'number' && p.minutes > 0 ? `${p.minutes}分` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 建的先后 = 机台上跑的顺序。 */
export function sortPrograms(rows: NcProgram[]): NcProgram[] {
  return [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

export function programsByComponent(
  rows: NcProgram[],
): Map<string, NcProgram[]> {
  const by = new Map<string, NcProgram[]>()
  for (const p of rows) {
    const arr = by.get(p.componentId) ?? []
    arr.push(p)
    by.set(p.componentId, arr)
  }
  for (const [k, arr] of by) by.set(k, sortPrograms(arr))
  return by
}

// === 复用 ===
//
// 同一个件第二次来, 上回的程序还在。这是这张单最值钱的地方 —— 不是记录, 是
// 省掉重编的那两个钟头。

/** 拿来配对的钥匙: 料号优先 (那是唯一的), 没有料号就用零件名。 */
export function reuseKey(part: { name?: string; partNo?: string }): string {
  const no = (part.partNo ?? '').trim().toLowerCase()
  if (no) return `no:${no}`
  const name = (part.name ?? '').trim().toLowerCase()
  return name ? `nm:${name}` : ''
}

/**
 * 这个件以前编过没有 —— 从别的工单上找同一个件最近的一套程序。
 * 只看别的工单 (同一张工单上的重复零件不算"以前"), 而且只给最近那一套, 不把
 * 历年攒下的十几条一起倒出来。
 */
export function findReusable(
  all: NcProgram[],
  key: string,
  currentJobId: string,
): NcProgram[] {
  if (!key) return []
  const hits = all.filter((p) => p.jobId !== currentJobId && p.partKey === key)
  if (hits.length === 0) return []
  const latest = hits.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
  return sortPrograms(
    hits.filter(
      (p) => p.jobId === latest.jobId && p.componentId === latest.componentId,
    ),
  )
}
