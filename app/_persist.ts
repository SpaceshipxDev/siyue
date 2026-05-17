'use client'

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// sessionStorage-backed useState. Survives the back-navigation from
// /jobs/[id] without crossing browser sessions.
//
// IMPORTANT: `hydrated` is STATE, not a ref. We rely on the closure capture:
// on first commit the write-effect sees `hydrated === false` and skips,
// so the initial render's default value never clobbers the persisted one
// in storage. A ref would mutate synchronously inside the read-effect and
// the write-effect (running right after, same commit) would see `true` and
// write the default. State holds the value steady until the next render.
//
// Scope `key` per view context so commerce-overview filters don't leak
// into station views.
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(defaultValue)
  const [hydrated, setHydrated] = useState(false)

  // Read once on mount, push storage value into state. Re-runs if `key`
  // ever changes (it shouldn't in practice, but stay defensive).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw !== null) setValue(JSON.parse(raw) as T)
    } catch {
      // storage may be unavailable (private mode, quota)
    }
    setHydrated(true)
  }, [key])

  // Write on every change AFTER hydration. The `hydrated` gate is what
  // prevents the first-commit clobber described in the file header.
  useEffect(() => {
    if (!hydrated) return
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore
    }
  }, [key, value, hydrated])

  return [value, setValue]
}
