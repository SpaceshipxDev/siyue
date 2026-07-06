// Same-origin URL prefix for the app. Next auto-applies `basePath` to
// next/link, router.push/replace and server redirect(), but it does NOT
// touch hand-built strings — fetch('/api/…'), <a href="/…">, <img src>,
// window.open(), copied share links, etc. Those must be wrapped in
// withBase() so they resolve correctly when the app is mounted under a
// sub-path (the /demo sales build served at siyue.ai/demo).
//
// NEXT_PUBLIC_ so the value inlines into BOTH the server and the client
// bundles at build time — basePath is fixed per build and can't be read
// from runtime env in the browser.
//
// Default is '' (empty string), which makes withBase() an exact identity:
// a build with no NEXT_PUBLIC_BASE_PATH set is byte-for-byte the current
// production behaviour.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ''

// Prefix a root-relative same-origin path with the build's base path.
// Only pass root-relative paths ('/api/…', '/jobs/…') — never absolute
// https:// URLs (Supabase storage) or data: URIs; those must not be
// prefixed. When BASE_PATH is '' this returns `p` unchanged.
export function withBase(p: string): string {
  return `${BASE_PATH}${p}`
}
