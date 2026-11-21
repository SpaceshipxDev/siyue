/*
 * 气泡图 —— 质量 · 检验用的那张「带编号气泡的图纸」和跟着它的质检报表
 * (于海伟 2026-11-21)。
 *
 * 一张 2D 图纸 (截图 / 扫描件 / 导出的图片), 图上每个要检的尺寸、形位公差、
 * 粗糙度标一个红色编号气泡; 报表一行对一个气泡: 图上写的原文、名义值、上下
 * 公差、实测值 (几件抽检就几列)、判定。气泡先让识图自动找, 漏的在图上点一下
 * 补, 位置不对拖一下。
 *
 * 纯类型 + 纯函数, 两端都能 import。存取在 lib/balloon-store.ts。
 */

export type BalloonKind = '尺寸' | '形位' | '粗糙度' | '角度' | '其他'
export const BALLOON_KINDS: BalloonKind[] = ['尺寸', '形位', '粗糙度', '角度', '其他']

export type Balloon = {
  n: number // 气泡编号
  x: number // 气泡在图上的位置, 0~1 (占图宽的比例)
  y: number // 0~1 (占图高的比例)
  spec: string // 图上写的原文: Ø40 H7、35.2+0.2/0、Rz 2.5、⫽ 0.05 A
  kind: BalloonKind
  nominal: string // 名义值
  tolUp: string // 上公差 (+0.2)
  tolDown: string // 下公差 (-0.05; 没有写 0)
  measured: string[] // 实测值, 一件一格
  gauge: string // 量具
}

/**
 * 外观检验 —— 图上技术要求里跟外观有关的那几条 (阳极氧化颜色、打标内容、倒角
 * 去毛刺、不允许划伤…), 一条一项, 逐项判 (于海伟 2026-11-21)。
 */
export type AppearanceItem = {
  item: string // 检验项目: 表面处理 / 打标 / 倒角毛刺 / 外观缺陷…
  req: string // 要求 (图上原话)
  result: '' | 'OK' | 'NG'
  note: string
}

export const DEFAULT_APPEARANCE: AppearanceItem[] = [
  { item: '外观缺陷', req: '无划伤、压伤、磕碰、毛刺', result: '', note: '' },
]

export function isAppearanceItem(x: unknown): x is AppearanceItem {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.item === 'string' &&
    typeof o.req === 'string' &&
    typeof o.note === 'string' &&
    (o.result === '' || o.result === 'OK' || o.result === 'NG')
  )
}

export type BalloonSheet = {
  id: string
  /** 挂在哪个零件上 —— 从工单零件那一行建的才有; 质量模块里直接传的没有。 */
  jobId: string
  componentId: string
  title: string // 图名 / 零件名
  drawingNo: string // 图号
  jobNo: string // 工单号
  customer: string
  material: string
  imageUrl: string
  /** 抽检几件 —— 实测值几列。 */
  samples: number
  balloons: Balloon[]
  appearance: AppearanceItem[]
  inspector: string // 检验员
  inspectedAt: string // 检验日期 YYYY-MM-DD
  note: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type BalloonSheetPatch = Partial<
  Pick<
    BalloonSheet,
    | 'title'
    | 'drawingNo'
    | 'jobNo'
    | 'customer'
    | 'material'
    | 'samples'
    | 'balloons'
    | 'appearance'
    | 'inspector'
    | 'inspectedAt'
    | 'note'
  >
>

export const MAX_SAMPLES = 10

export function emptyBalloon(n: number, x: number, y: number, samples: number): Balloon {
  return {
    n,
    x,
    y,
    spec: '',
    kind: '尺寸',
    nominal: '',
    tolUp: '',
    tolDown: '',
    measured: Array.from({ length: samples }, () => ''),
    gauge: '',
  }
}

const num = (s: string): number | null => {
  const t = s.trim().replace(/^\+/, '').replace(/[Øø⌀]/g, '')
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

function fmt(v: number): string {
  return String(Math.round(v * 10000) / 10000)
}

/** 上限 / 下限 —— 名义值加上下公差; 名义值不是数字 (粗糙度、形位) 就空着。 */
export function limits(b: Balloon): { hi: string; lo: string } {
  const n = num(b.nominal)
  if (n === null) return { hi: '', lo: '' }
  const up = num(b.tolUp) ?? 0
  const down = num(b.tolDown) ?? 0
  return { hi: fmt(n + up), lo: fmt(n + down) }
}

/**
 * 一个实测值合不合格。
 *   有上下限 (尺寸、角度): 落在 [下限, 上限] 里就是 OK。
 *   只有一个数 (形位公差 0.05、粗糙度 Rz 2.5): 不超过它就是 OK。
 *   填的不是数字 (OK / NG / 合格 / 不合格): 照字面认。
 */
export function judge(b: Balloon, v: string): 'OK' | 'NG' | '' {
  const t = v.trim()
  if (!t) return ''
  if (/^(ok|合格|√|✓|y)$/i.test(t)) return 'OK'
  if (/^(ng|不合格|×|✗|x|n)$/i.test(t)) return 'NG'
  const m = num(t)
  if (m === null) return ''
  const { hi, lo } = limits(b)
  if (hi !== '' && lo !== '') {
    const h = Number(hi)
    const l = Number(lo)
    const eps = 1e-9
    return m <= Math.max(h, l) + eps && m >= Math.min(h, l) - eps ? 'OK' : 'NG'
  }
  // 形位 / 粗糙度: 公差就是上限 (写在名义值或上公差里)。
  const cap = num(b.tolUp) ?? num(b.nominal)
  if (cap === null) return ''
  return m <= cap + 1e-9 ? 'OK' : 'NG'
}

/** 这一行的判定: 有一件 NG 就是 NG; 都 OK 才 OK; 没填完就空着。 */
export function rowVerdict(b: Balloon, samples: number): 'OK' | 'NG' | '' {
  const vs = b.measured.slice(0, samples).map((v) => judge(b, v))
  if (vs.includes('NG')) return 'NG'
  if (vs.length > 0 && vs.every((v) => v === 'OK')) return 'OK'
  return ''
}

/** 整张报表的结论: 尺寸或外观有一行 NG 就不合格; 每一行都 OK 才合格。 */
export function sheetVerdict(s: BalloonSheet): '合格' | '不合格' | '' {
  const vs = [
    ...s.balloons.map((b) => rowVerdict(b, s.samples)),
    ...(s.appearance ?? []).map((a) => a.result),
  ]
  if (vs.includes('NG')) return '不合格'
  if (vs.length > 0 && vs.every((v) => v === 'OK')) return '合格'
  return ''
}

export function isBalloon(x: unknown): x is Balloon {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.n === 'number' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.spec === 'string' &&
    typeof o.nominal === 'string' &&
    typeof o.tolUp === 'string' &&
    typeof o.tolDown === 'string' &&
    typeof o.gauge === 'string' &&
    BALLOON_KINDS.includes(o.kind as BalloonKind) &&
    Array.isArray(o.measured) &&
    o.measured.every((m) => typeof m === 'string')
  )
}
