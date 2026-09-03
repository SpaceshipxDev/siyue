import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { normalizeRates, type QuoteRates, type RateItem } from './quote'

/*
 * 报价模板 — 那一套费率。
 *
 * 一个文件, table-free, 跟 人事 / 工资 / 住宿 同一个路子: 没有 migration 要
 * 人去应用, 库没升级也打得开页面。一个厂一套费率, 就几十个数。
 *
 * 报价单本身不存在这里 —— 报的是还没接的单, 一天可能报五次同一个零件试不同
 * 数量。那些留在浏览器里 (刷新不丢, 关掉就算), 只有费率是长期的资产。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const RATES_KEY = 'quote/rates.json'

export async function getQuoteRates(): Promise<QuoteRates> {
  return read()
}

async function save(rates: QuoteRates): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(RATES_KEY, Buffer.from(JSON.stringify(rates), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

async function read(): Promise<QuoteRates> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(RATES_KEY)
  if (error || !data) return normalizeRates(null)
  try {
    return normalizeRates(JSON.parse(await data.text()))
  } catch {
    return normalizeRates(null)
  }
}

export type ScalarRateKey =
  | 'machineRatePerHour'
  | 'marginPct'
  | 'paintPerPiece'
  | 'screenPerPiece'

export function isScalarRateKey(x: unknown): x is ScalarRateKey {
  return (
    x === 'machineRatePerHour' ||
    x === 'marginPct' ||
    x === 'paintPerPiece' ||
    x === 'screenPerPiece'
  )
}

export async function setQuoteScalar(
  key: ScalarRateKey,
  value: number,
): Promise<void> {
  await withLock(async () => {
    const rates = await read()
    rates[key] = value
    await save(rates)
  })
}

export type RateList = 'materials' | 'surfaces'

export function isRateList(x: unknown): x is RateList {
  return x === 'materials' || x === 'surfaces'
}

// 一张单价表的一行 — 改名字、改价、删掉都是同一个写。name 为空 = 删这一行。
export async function setQuoteRateItem(
  list: RateList,
  index: number,
  item: RateItem | null,
): Promise<void> {
  await withLock(async () => {
    const rates = await read()
    const rows = [...rates[list]]
    if (index < 0 || index >= rows.length) {
      if (item) rows.push(item)
    } else if (item === null) {
      rows.splice(index, 1)
    } else {
      rows[index] = item
    }
    rates[list] = rows
    await save(rates)
  })
}
