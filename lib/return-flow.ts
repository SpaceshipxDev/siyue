/*
 * 退货流转单 — 一条退货从客户打电话回来, 到返工好再发出去, 中间要过几个人的手。
 *
 * 商务开单 (退了什么 · 不良原因 · 二次交期) 已经落在 returns 表里, 那是这条
 * 退货的身份。这里定的是它之后那几笔字的形状, 每一笔都署名署日:
 *
 *   处理方案   工程   — 这批件怎么救 (返修哪几道 / 报废重做 / 让步接收)
 *   原因调查   质量   — 为什么会出这个不良, 以后怎么不再犯
 *   下发返工   工程   — 方案和调查都有了, 打一张返工工单交到车间
 *   返工入库   生产   — 做完了, 几件回到成品
 *   制作出货单 商务   — 再发一次货
 *
 * 一格字一个人, 填完就是他的签名 —— 谁签的、哪天签的, 事后不用问。
 *
 * 纯类型和纯判断 ⇒ 服务端 (mutate / 返工工单) 和客户端 (退货台那张流转单)
 * 都能 import。真正的读写在 lib/return-flow-store.ts, 那一份带 server-only。
 */

export type ReturnFlow = {
  returnId: string
  /** 处理方案 — 工程 */
  plan?: string
  planBy?: string
  planAt?: string
  /** 原因调查 — 质量 */
  cause?: string
  causeBy?: string
  causeAt?: string
  /** 下发返工 — 那张交到车间的返工工单是哪天开的 */
  releasedAt?: string
  releasedBy?: string
  /** 返工入库 — 做完了几件回到成品 */
  stockedAt?: string
  stockedBy?: string
  stockedQty?: number
  /** 返工后再发的那张出货单 */
  shippedAt?: string
  shippedBy?: string
  shipmentId?: string
}

// === 走到哪一步 ===
//
// 派生, 不存 —— 存一个 step 字段就一定会有跟那几格字对不上的一天。

export type ReturnStep = 'plan' | 'cause' | 'release' | 'rework' | 'ship' | 'done'

export const RETURN_STEP_LABEL: Record<ReturnStep, string> = {
  plan: '待工程方案',
  cause: '待质量调查',
  release: '待下发返工',
  rework: '返工中',
  ship: '待出货',
  done: '可结案',
}

/** 这一步在等谁 —— 列表上一眼看出球在谁脚下。 */
export const RETURN_STEP_OWNER: Record<ReturnStep, string> = {
  plan: '工程',
  cause: '质量',
  release: '工程',
  rework: '生产',
  ship: '商务',
  done: '商务',
}

export function returnStep(f: ReturnFlow | undefined): ReturnStep {
  if (!f?.plan) return 'plan'
  if (!f.cause) return 'cause'
  if (!f.releasedAt) return 'release'
  if (!f.stockedAt) return 'rework'
  if (!f.shippedAt) return 'ship'
  return 'done'
}

/** 能写进流转单的那几笔。签名和日期由服务端盖, 前端传不进来。 */
export type ReturnFlowEntry =
  | { kind: 'plan'; text: string }
  | { kind: 'cause'; text: string }
  | { kind: 'release' }
  | { kind: 'stock'; qty?: number }
  | { kind: 'ship'; shipmentId?: string }
