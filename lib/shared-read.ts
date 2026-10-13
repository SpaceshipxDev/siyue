import 'server-only'

/*
 * 全厂共用的那几份汇总 —— 一次算, 大家用。
 *
 * 看板上的逾期/今日、收款那一列、大单标记、各工段平均停留, 对每个人都是同一
 * 个答案, 却是每打开一次、每点一下报工 (写完会刷新页面) 就整份重算一遍。三
 * 十个人同时在用, 数据库就在同一时刻把同一份东西算三十遍, 大家一起转圈。
 *
 * 这里做两件事:
 *   · 同时来的一起等 —— 一份正在算, 后来的人直接等它, 不再另起一份。
 *   · 算好的留几秒 —— 几秒之内再要, 直接给。
 *
 * followWrites: 这个进程里一有写, 就不再拿之前的结果 (报工点了 ✓, 刷新回来
 * 的数要是新的)。不跟写的那几份 (收款、平均停留) 靠时间过期就够了。
 */

type Entry = { at: number; gen: number; value: Promise<unknown> }

const entries = new Map<string, Entry>()
let generation = 0

/** 有写落库了 —— 跟写的那几份从下一次读起重新算。 */
export function markWritten(): void {
  generation += 1
}

export function sharedRead<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts: { followWrites?: boolean } = {},
): Promise<T> {
  const now = Date.now()
  const hit = entries.get(key)
  if (
    hit &&
    now - hit.at < ttlMs &&
    (!opts.followWrites || hit.gen === generation)
  ) {
    return hit.value as Promise<T>
  }
  const value = load()
  const entry: Entry = { at: now, gen: generation, value }
  entries.set(key, entry)
  // 算失败了不留着 —— 下一个人重新算, 不把一次网络抖动传给所有人。
  value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key)
  })
  return value
}
