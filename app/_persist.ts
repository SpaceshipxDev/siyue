'use client'

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

// sessionStorage-backed useState. Survives the back-navigation from
// /jobs/[id] without crossing browser sessions (each tab keeps its own
// view of "what I was filtering by"). Server render falls back to the
// default; the client re-applies the stored value on first effect, which
// may produce one brief paint with the default — acceptable for filter
// chrome.
//
// `key` should be scoped per view context so that filters on the commerce
// overview don't leak into a station view (and vice versa).
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(defaultValue)
  const hydrated = useRef(false)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw !== null) setValue(JSON.parse(raw) as T)
    } catch {
      // ignore — storage may be unavailable (private mode, quota)
    }
    hydrated.current = true
  }, [key])

  useEffect(() => {
    if (!hydrated.current) return
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore
    }
  }, [key, value])

  return [value, setValue]
}
