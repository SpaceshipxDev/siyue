// Language layer shared by the factory apps. Chinese is the default and is
// NEVER touched server-side. The only things this does:
//   1. `?lang=en` / `?lang=zh` on any URL → set the sy_lang cookie (1 year)
//      and redirect to the same URL without the param.
//   2. No sy_lang cookie yet + client IP geolocates to the US → set
//      sy_lang=en on the response. Nothing else changes: the HTML is still
//      the Chinese render; /i18n/en.js on the client does the translating.
// Anything throwing inside here is swallowed → behaves as if absent.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clientIp, isUsIp } from "./geo-us";

export const LANG_COOKIE = "sy_lang";
const YEAR = 60 * 60 * 24 * 365;

function setLang(res: NextResponse, lang: "en" | "zh") {
  res.cookies.set(LANG_COOKIE, lang, {
    path: "/",
    maxAge: YEAR,
    sameSite: "lax",
    httpOnly: false, // the client script reads it
  });
}

/** Call first: returns a redirect response when ?lang= is present. */
export function langRedirect(req: NextRequest): NextResponse | null {
  try {
    const q = req.nextUrl.searchParams.get("lang");
    if (q !== "en" && q !== "zh") return null;
    const url = req.nextUrl.clone();
    url.searchParams.delete("lang");
    const res = NextResponse.redirect(url, 302);
    setLang(res, q);
    return res;
  } catch {
    return null;
  }
}

/** Call last: decorate the outgoing response with the geo cookie (US only). */
export function langDecorate(req: NextRequest, res: NextResponse): NextResponse {
  try {
    if (req.cookies.get(LANG_COOKIE)) return res;
    // Belt and braces: a browser whose primary language is Chinese is never
    // auto-switched, even from a US IP (VPN, ARIN-registered cloud ranges).
    const al = req.headers.get("accept-language") || "";
    if (/^\s*zh/i.test(al)) return res;
    if (isUsIp(clientIp(req.headers))) setLang(res, "en");
  } catch {
    /* never let the language layer break a request */
  }
  return res;
}
