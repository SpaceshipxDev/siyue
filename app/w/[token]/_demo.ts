import type { OutsourceBlock, Vendor } from '@/lib/data'
import { today } from '@/lib/today'

// /w/demo — a fully fictional vendor board. Two jobs:
//   1. Verification: every card state (未确认 / 逾期追问 / 迟诺+原因 / 已发货 /
//      已完成) renders without touching a single real row.
//   2. Sales: the link we can send any prospect factory — "这就是你外协厂看到
//      的界面" — with zero real data behind it.
// Dates are computed off today() so the demo never goes stale. Actions on the
// demo token redirect back without writing (see _actions.ts).

export const DEMO_TOKEN = 'demo'

// Demo answers persist in this cookie (per visitor, per browser) so the demo
// board behaves exactly like the live one — taps fill cells — without ever
// touching a real row. See applyDemoCookie / demoStateUpdate.
export const DEMO_COOKIE = 'wdemo'

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function demoVendor(): Vendor {
  return {
    id: '__demo__',
    name: '恒宇精密（示例）',
    portalToken: DEMO_TOKEN,
  }
}

export function demoBlocks(): OutsourceBlock[] {
  const t = today()
  const iso = (ymd: string) => `${ymd}T02:00:00.000Z`
  const mk = (
    n: number,
    b: Partial<OutsourceBlock>,
    members: OutsourceBlock['members'],
  ): OutsourceBlock => ({
    id: `demo-${n}`,
    vendorId: '__demo__',
    stages: [],
    amountCny: null,
    sentDate: t,
    expectedReturn: t,
    docNo: `SY-${t.slice(2, 4)}-${Number(t.slice(5, 7))}-${Number(t.slice(8, 10))}-00${n}`,
    members,
    ...b,
  })
  return [
    // 新到货 — the first tap (确认收到).
    mk(
      1,
      {
        activity: '外发氧化',
        amountCny: 360,
        sentDate: addDays(t, -1),
        expectedReturn: addDays(t, 4),
        notes: '本色氧化，保护好丝印面',
      },
      [
        { componentId: 'd1a', name: '上盖板', qty: 2, material: '6061铝' },
        { componentId: 'd1b', name: '底座支架', qty: 1, material: '6061铝' },
      ],
    ),
    // 逾期未答 — the "几号能交?" chips.
    mk(
      2,
      {
        activity: '外发CNC',
        amountCny: 1200,
        sentDate: addDays(t, -9),
        expectedReturn: addDays(t, -2),
        vendorSeenAt: iso(addDays(t, -1)),
        vendorAckAt: iso(addDays(t, -8)),
      },
      [{ componentId: 'd2a', name: '转接法兰', qty: 5, material: '304不锈钢' }],
    ),
    // 已诺迟 + 原因 — what the factory sees before anyone has to phone.
    mk(
      3,
      {
        activity: '外发电镀',
        amountCny: 480,
        sentDate: addDays(t, -3),
        expectedReturn: addDays(t, 2),
        vendorSeenAt: iso(t),
        vendorAckAt: iso(addDays(t, -2)),
        vendorPromisedDate: addDays(t, 4),
        vendorDelayReason: '排队中',
      },
      [{ componentId: 'd3a', name: '装饰圈', qty: 2, material: '黄铜' }],
    ),
    // 已发货 — waiting on the factory's 收件.
    mk(
      4,
      {
        activity: '外发打印',
        amountCny: 150,
        sentDate: addDays(t, -4),
        expectedReturn: addDays(t, 1),
        vendorAckAt: iso(addDays(t, -3)),
        vendorShippedAt: iso(t),
      },
      [{ componentId: 'd4a', name: '手柄外壳', qty: 1, material: '树脂' }],
    ),
    // 已完成 — archive + 对账 rows.
    mk(
      5,
      {
        activity: '外发钣金',
        amountCny: 900,
        sentDate: addDays(t, -20),
        expectedReturn: addDays(t, -12),
      },
      [
        {
          componentId: 'd5a',
          name: '安装底板',
          qty: 4,
          material: 'SPCC',
          returnedQty: 4,
          returnedAt: addDays(t, -12),
        },
      ],
    ),
    mk(
      6,
      {
        activity: '外发氧化',
        amountCny: 260,
        sentDate: addDays(t, -34),
        expectedReturn: addDays(t, -28),
      },
      [
        {
          componentId: 'd6a',
          name: '散热壳',
          qty: 6,
          material: '6061铝',
          returnedQty: 6,
          returnedAt: addDays(t, -28),
        },
      ],
    ),
  ]
}
