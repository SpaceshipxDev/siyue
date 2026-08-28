"use client";
import { useEffect } from "react";

// Renders nothing. Its only job: tell /i18n/en.js (loaded by the inline
// boot script in layout.tsx, US visitors only) that React has finished its
// initial hydration commit, so DOM translation starts AFTER hydration and
// can never cause a hydration mismatch. For Chinese users this is a no-op.
export function EnBoot() {
  useEffect(() => {
    try {
      (window as unknown as { __syHydrated?: boolean }).__syHydrated = true;
      window.dispatchEvent(new Event("sy:hydrated"));
    } catch {}
  }, []);
  return null;
}
