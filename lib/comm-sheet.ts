/*
 * 工程部沟通确认单 — 接单前后跟客户把技术细节谈定的那张纸。
 *
 * 一张单管七件事, 每件事都是同一个三段式:
 *   客户提的要求 → 我司的方案 / 风险提示 → 双方最终结论
 *
 * 三段缺一不可, 而且最值钱的是第三段。前两段是各说各的, 只有"最终结论"是双
 * 方点过头的那一句 —— 半年后扯皮时, 车间照着做的、质检照着判的、客户拿来对
 * 的, 都是它。
 *
 * 为什么要进系统: 这张表现在是 Excel, 谈完存在跟单的电脑里。于是喷涂那一段
 * 写的"客户指定色号 RAL7016 · 膜厚 60μm", 喷漆房的人是看不到的 —— 他要么去
 * 问, 要么按平常那样喷。凡是"谈好了但车间不知道"的事, 最后都变成返工。
 *
 * 所以这张单在系统里的规矩是: 工程和商务填, 全厂都看得见。喷漆的人打开工
 * 单就能读到客户对喷涂那一栏的结论, 不用问第二个人。
 *
 * 纯类型和纯判断 ⇒ 两端都能 import。读写在 lib/comm-sheet-store.ts。
 */

/** 七个沟通项 —— 顺着零件在厂里走的路排: 结构 → 公差 → 机加 → 手工 → 喷涂 → 丝印 → 表面。 */
export const COMM_TOPICS = [
  'structure',
  'tolerance',
  'machining',
  'handwork',
  'paint',
  'silk',
  'surface',
] as const

export type CommTopic = (typeof COMM_TOPICS)[number]

/** 一项里的三段, 各自的抬头 —— 和纸质表上的字一模一样。 */
export type CommTopicSpec = {
  key: CommTopic
  title: string
  /** 这一项主要说给哪个工段听 —— 车间打开工单时, 自己那一段会被点出来。 */
  stage?: string
  askLabel: string
  oursLabel: string
}

export const COMM_TOPIC_SPECS: CommTopicSpec[] = [
  {
    key: 'structure',
    title: '产品结构',
    askLabel: '客户提出的结构核心要求',
    oursLabel: '我司标注的风险点与优化建议',
  },
  {
    key: 'tolerance',
    title: '公差标准',
    askLabel: '图纸标注关键公差清单',
    oursLabel: '我司补充的未注公差执行标准',
  },
  {
    key: 'machining',
    title: '机加工工序',
    stage: '操机',
    askLabel: '客户工艺特殊要求',
    oursLabel: '我司生产计划与精度保障方案',
  },
  {
    key: 'handwork',
    title: '手工后处理',
    stage: '手工',
    askLabel: '客户对毛刺、倒钝、清屑、攻牙、粘贴的特殊要求',
    oursLabel: '我司全检执行标准',
  },
  {
    key: 'paint',
    title: '喷涂工艺',
    stage: '喷漆',
    askLabel: '客户指定色号、膜厚、遮蔽要求',
    oursLabel: '我司前处理与喷涂执行方案',
  },
  {
    key: 'silk',
    title: '丝印细节',
    stage: '丝印',
    askLabel: '客户提供的文件、位置、字体要求',
    oursLabel: '我司定位工装与效果保障方案',
  },
  {
    key: 'surface',
    title: '最终表面处理',
    stage: '表处',
    askLabel: '客户外观、防护、包装特殊要求',
    oursLabel: '我司最终质检与防护方案',
  },
]

export const COMM_AGREED_LABEL = '双方沟通后最终结论'

/** 项目当前阶段 —— 纸上那一排方框, 只能是其中一个 ("当前"不会有两个)。 */
export const COMM_STAGES = [
  '需求初评',
  '工艺确认',
  '生产中',
  '后处理',
  '交付前',
  '交付后',
] as const

export type CommStage = (typeof COMM_STAGES)[number]

export function isCommStage(x: unknown): x is CommStage {
  return typeof x === 'string' && (COMM_STAGES as readonly string[]).includes(x)
}

export function isCommTopic(x: unknown): x is CommTopic {
  return typeof x === 'string' && (COMM_TOPICS as readonly string[]).includes(x)
}

export type CommEntry = {
  /** 客户提的 */
  ask?: string
  /** 我司的方案 / 风险 */
  ours?: string
  /** 双方点过头的那一句 —— 车间和质检照着做的就是它 */
  agreed?: string
}

export type CommSheet = {
  jobId: string
  /** 项目名称 —— 空着就用工单的产品名 */
  projectName?: string
  customerContact?: string
  ourContact?: string
  /** 沟通日期 YYYY-MM-DD */
  talkedAt?: string
  stage?: CommStage
  items: Partial<Record<CommTopic, CommEntry>>
  by?: string
  updatedAt?: string
}

export function emptyCommSheet(jobId: string): CommSheet {
  return { jobId, items: {} }
}

/** 这一项谈过没有 —— 三格里有任意一格有字就算谈过。 */
export function topicFilled(e?: CommEntry): boolean {
  return !!(e?.ask?.trim() || e?.ours?.trim() || e?.agreed?.trim())
}

/** 这一项谈定了没有 —— 只有"最终结论"落笔才算定。 */
export function topicAgreed(e?: CommEntry): boolean {
  return !!e?.agreed?.trim()
}

/** 谈定了几项 / 动过几项 —— 工单页的 tab 上就靠这个数说话。 */
export function commProgress(sheet: CommSheet | undefined): {
  touched: number
  agreed: number
  total: number
} {
  let touched = 0
  let agreed = 0
  for (const t of COMM_TOPICS) {
    const e = sheet?.items?.[t]
    if (topicFilled(e)) touched++
    if (topicAgreed(e)) agreed++
  }
  return { touched, agreed, total: COMM_TOPICS.length }
}

/** 一张单有没有内容 —— 全空的单不该在工单页上摆出存在感。 */
export function commSheetIsEmpty(sheet: CommSheet | undefined): boolean {
  if (!sheet) return true
  if (
    sheet.projectName?.trim() ||
    sheet.customerContact?.trim() ||
    sheet.ourContact?.trim() ||
    sheet.talkedAt ||
    sheet.stage
  )
    return false
  return commProgress(sheet).touched === 0
}
