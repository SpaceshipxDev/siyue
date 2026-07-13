'use client'

// caiwu-lab — shared in-memory write store. All three designs read and write
// through ONE provider mounted above the switcher, so appending a 开票 in 分期账
// is instantly visible when you flip to 流水卡 (one truth, three skins).
//
// Writes are local + synchronous (optimistic append). A real /api/mutate with
// kinds 'addInvoiceEvent' / 'addPaymentEvent' slots in behind addEvent() once
// the installment migration lands — flip nothing in the UI.

import { createContext, useContext, useMemo, useReducer } from 'react'
import {
  SEED_EVENTS,
  SEED_JOBS,
  SEED_POLINES,
  type EventKind,
  type Job,
  type MoneyEvent,
  type PoLine,
} from './_mock'

interface State {
  jobs: Job[]
  lines: PoLine[]
  events: MoneyEvent[]
  seq: number
}

type Action =
  | { type: 'add'; poLineId: string; kind: EventKind; amountCny: number; date: string }
  | { type: 'voidLast'; poLineId: string }
  | { type: 'addOrder'; customer: string; poNo: string; amountCny: number; date: string; product?: string }
  | { type: 'reset' }

function initState(): State {
  return {
    jobs: SEED_JOBS,
    lines: SEED_POLINES,
    events: [...SEED_EVENTS],
    seq: SEED_EVENTS.length + 1,
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'add': {
      const ev: MoneyEvent = {
        id: `ev-new-${state.seq}`,
        poLineId: action.poLineId,
        kind: action.kind,
        amountCny: action.amountCny,
        date: action.date,
      }
      return { ...state, events: [...state.events, ev], seq: state.seq + 1 }
    }
    case 'voidLast': {
      // Remove the most-recently-appended event on this line (the only one the
      // UI ever lets you undo). Newest = highest index among this line's events.
      let removeIdx = -1
      for (let i = state.events.length - 1; i >= 0; i--) {
        if (state.events[i].poLineId === action.poLineId) {
          removeIdx = i
          break
        }
      }
      if (removeIdx < 0) return state
      const next = state.events.slice()
      next.splice(removeIdx, 1)
      return { ...state, events: next }
    }
    case 'addOrder': {
      // Her "+ 新增一行": a brand-new order typed at the bottom of the sheet.
      // One PO line (single-PO is the common manual case); no events yet.
      const jobId = `YNMX-新-${state.seq}`
      const job: Job = {
        id: jobId,
        customer: action.customer,
        product: action.product ?? '',
        salesperson: '',
        amountCny: action.amountCny,
        shipDate: action.date,
      }
      const line: PoLine = {
        id: `${jobId}:0`,
        jobId,
        poNo: action.poNo,
        poAmountCny: action.amountCny,
      }
      return {
        ...state,
        jobs: [job, ...state.jobs],
        lines: [line, ...state.lines],
        seq: state.seq + 1,
      }
    }
    case 'reset':
      return initState()
    default:
      return state
  }
}

export interface MockStore {
  jobs: Job[]
  lines: PoLine[]
  events: MoneyEvent[]
  addEvent: (poLineId: string, kind: EventKind, amountCny: number, date: string) => void
  voidLastEvent: (poLineId: string) => void
  addOrder: (order: { customer: string; poNo: string; amountCny: number; date: string; product?: string }) => void
  reset: () => void
}

const StoreContext = createContext<MockStore | null>(null)

export function MockStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState)
  const store = useMemo<MockStore>(
    () => ({
      jobs: state.jobs,
      lines: state.lines,
      events: state.events,
      addEvent: (poLineId, kind, amountCny, date) =>
        dispatch({ type: 'add', poLineId, kind, amountCny, date }),
      voidLastEvent: (poLineId) => dispatch({ type: 'voidLast', poLineId }),
      addOrder: (order) => dispatch({ type: 'addOrder', ...order }),
      reset: () => dispatch({ type: 'reset' }),
    }),
    [state],
  )
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useMockStore(): MockStore {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useMockStore must be used within MockStoreProvider')
  return ctx
}
