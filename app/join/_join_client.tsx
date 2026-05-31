'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from 'react'
import { joinWaitlist } from './actions'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Phase = 'hero' | 'form' | 'done'

type Data = {
  email: string
  tiktok: string
  instagram: string
  brands: string
}

const TOTAL_STEPS = 3

export function AfterlightJoin() {
  const [phase, setPhase] = useState<Phase>('hero')
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState<1 | -1>(1)
  const [data, setData] = useState<Data>({
    email: '',
    tiktok: '',
    instagram: '',
    brands: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [alreadyJoined, setAlreadyJoined] = useState(false)
  const [isPending, startTransition] = useTransition()

  const set = (patch: Partial<Data>) => {
    setError(null)
    setData((d) => ({ ...d, ...patch }))
  }

  const canAdvance = useCallback(
    (s: number): boolean => {
      if (s === 0) return EMAIL_RE.test(data.email.trim())
      if (s === 1) return Boolean(data.tiktok.trim() || data.instagram.trim())
      return true // brands — optional
    },
    [data],
  )

  const launch = useCallback(() => {
    setDir(1)
    setStep(0)
    setError(null)
    setPhase('form')
  }, [])

  const submit = useCallback(() => {
    startTransition(async () => {
      const res = await joinWaitlist({
        email: data.email,
        tiktok: data.tiktok,
        instagram: data.instagram,
        brands: data.brands,
      })
      if (res.ok) {
        setAlreadyJoined(res.alreadyJoined)
        setPhase('done')
      } else {
        setError(res.error)
      }
    })
  }, [data])

  const next = useCallback(() => {
    if (isPending) return
    if (!canAdvance(step)) {
      if (step === 0) setError('Enter a valid email to continue.')
      else if (step === 1) setError('Add at least one handle so brands can find you.')
      return
    }
    if (step >= TOTAL_STEPS - 1) {
      submit()
      return
    }
    setDir(1)
    setError(null)
    setStep((s) => s + 1)
  }, [canAdvance, isPending, step, submit])

  const back = useCallback(() => {
    if (isPending) return
    setDir(-1)
    setError(null)
    if (step === 0) {
      setPhase('hero')
      return
    }
    setStep((s) => s - 1)
  }, [isPending, step])

  // Enter on the hero launches the flow — Typeform habit.
  useEffect(() => {
    if (phase !== 'hero') return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        launch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, launch])

  const onFieldKeyDown = (e: KeyboardEvent, opts?: { multiline?: boolean }) => {
    if (e.key === 'Enter' && !(opts?.multiline && e.shiftKey)) {
      e.preventDefault()
      next()
    }
  }

  return (
    <div className="al-root relative min-h-dvh w-full overflow-hidden">
      <GlowField phase={phase} />

      <Wordmark />

      {/* HERO */}
      {phase === 'hero' && (
        <section className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-6 text-center">
          <p className="al-rise al-label" style={{ animationDelay: '80ms' }}>
            Early access · for creators
          </p>
          <h1
            className="al-rise mt-6 max-w-[16ch] text-balance text-[clamp(2.4rem,6.4vw,5.1rem)] font-semibold leading-[1.02] tracking-[-0.03em]"
            style={{ animationDelay: '180ms' }}
          >
            Get paid for brand campaigns without filming new content
          </h1>
          <p
            className="al-rise mt-7 max-w-[44ch] text-[clamp(1.02rem,1.9vw,1.3rem)] leading-[1.5] text-[var(--al-ink-2)]"
            style={{ animationDelay: '300ms' }}
          >
            Generate AI versions of yourself that sells branded products without
            you having to film.
          </p>
          <div
            className="al-rise mt-12 flex items-center gap-4"
            style={{ animationDelay: '440ms' }}
          >
            <button type="button" className="al-btn" onClick={launch}>
              Join
              <ArrowIcon />
            </button>
            <span className="al-enter-hint">
              press <kbd>Enter</kbd> <ReturnIcon />
            </span>
          </div>
        </section>
      )}

      {/* FORM — one question per screen, Typeform-style */}
      {phase === 'form' && (
        <section className="relative z-10 flex min-h-dvh flex-col justify-center px-6 sm:px-10">
          <div className="mx-auto w-full max-w-[680px]">
            <div
              key={step}
              className={dir === 1 ? 'al-q al-q-up' : 'al-q al-q-down'}
            >
              {step === 0 && (
                <Question
                  index={1}
                  title="What's your email?"
                  desc="So we can tell you the moment your spot opens."
                >
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoFocus
                    className="al-input"
                    placeholder="name@email.com"
                    value={data.email}
                    onChange={(e) => set({ email: e.target.value })}
                    onKeyDown={onFieldKeyDown}
                  />
                </Question>
              )}

              {step === 1 && (
                <Question
                  index={2}
                  title="Where can brands find you?"
                  desc="Drop your TikTok and / or Instagram. One is enough."
                >
                  <div className="space-y-7">
                    <HandleField
                      label="TikTok"
                      placeholder="@yourhandle"
                      value={data.tiktok}
                      autoFocus
                      onChange={(v) => set({ tiktok: v })}
                      onKeyDown={onFieldKeyDown}
                    />
                    <HandleField
                      label="Instagram"
                      placeholder="@yourhandle"
                      value={data.instagram}
                      onChange={(v) => set({ instagram: v })}
                      onKeyDown={onFieldKeyDown}
                    />
                  </div>
                </Question>
              )}

              {step === 2 && (
                <Question
                  index={3}
                  title="Which brands do you work with — or want to?"
                  desc="The names you already partner with, plus your dream list. Optional."
                >
                  <textarea
                    autoFocus
                    rows={2}
                    className="al-input al-textarea"
                    placeholder="e.g. Glossier, Gymshark, Notion — and the ones you'd love to."
                    value={data.brands}
                    onChange={(e) => set({ brands: e.target.value })}
                    onKeyDown={(e) => onFieldKeyDown(e, { multiline: true })}
                  />
                </Question>
              )}

              <div className="mt-9 flex items-center gap-4">
                <button
                  type="button"
                  className="al-btn"
                  onClick={next}
                  disabled={isPending}
                >
                  {isPending
                    ? 'Joining…'
                    : step === TOTAL_STEPS - 1
                      ? 'Submit'
                      : 'OK'}
                  {!isPending &&
                    (step === TOTAL_STEPS - 1 ? <ArrowIcon /> : <CheckIcon />)}
                </button>
                {!isPending && (
                  <span className="al-enter-hint">
                    press <kbd>Enter</kbd> <ReturnIcon />
                  </span>
                )}
              </div>

              {error && <p className="al-error mt-5">{error}</p>}
            </div>
          </div>

          <FormNav
            step={step}
            total={TOTAL_STEPS}
            canForward={canAdvance(step)}
            pending={isPending}
            onUp={back}
            onDown={next}
          />
        </section>
      )}

      {/* SUCCESS */}
      {phase === 'done' && (
        <section className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-6 text-center">
          <div className="al-rise" style={{ animationDelay: '60ms' }}>
            <SealIcon />
          </div>
          <h2
            className="al-rise al-serif mt-8 text-[clamp(2.2rem,5vw,3.6rem)] leading-[1.05] tracking-[-0.01em]"
            style={{ animationDelay: '160ms' }}
          >
            {alreadyJoined ? 'You’re already on the list.' : 'You’re on the list.'}
          </h2>
          <p
            className="al-rise mt-5 max-w-[40ch] text-[1.05rem] leading-[1.5] text-[var(--al-ink-2)]"
            style={{ animationDelay: '280ms' }}
          >
            We’ll reach out to{' '}
            <span className="text-[var(--al-ink)]">{data.email.trim()}</span> the
            moment your spot opens.
          </p>
        </section>
      )}

      <StyleBlock />
    </div>
  )
}

function Wordmark() {
  return (
    <div className="absolute left-6 top-6 z-20 flex items-center gap-2.5 sm:left-10 sm:top-8">
      <span className="al-orb" aria-hidden />
      <span className="al-serif text-[1.35rem] leading-none tracking-[0.02em]">
        Afterlight
      </span>
    </div>
  )
}

function GlowField({ phase }: { phase: Phase }) {
  return (
    <div
      className={`al-glow pointer-events-none absolute inset-0 z-0 ${
        phase === 'done' ? 'al-glow-bloom' : ''
      }`}
      aria-hidden
    >
      <span className="al-blob al-blob-warm" />
      <span className="al-blob al-blob-cool" />
    </div>
  )
}

function Question({
  index,
  title,
  desc,
  children,
}: {
  index: number
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="al-qnum">
          {index} <span aria-hidden>→</span>
        </span>
      </div>
      <h2 className="mt-3 text-[clamp(1.5rem,3.4vw,2.25rem)] font-medium leading-[1.18] tracking-[-0.015em]">
        {title}
      </h2>
      {desc && (
        <p className="mt-3 text-[1rem] leading-[1.5] text-[var(--al-ink-3)]">
          {desc}
        </p>
      )}
      <div className="mt-9">{children}</div>
    </div>
  )
}

function HandleField({
  label,
  placeholder,
  value,
  autoFocus,
  onChange,
  onKeyDown,
}: {
  label: string
  placeholder: string
  value: string
  autoFocus?: boolean
  onChange: (v: string) => void
  onKeyDown: (e: KeyboardEvent) => void
}) {
  return (
    <label className="block">
      <span className="al-field-label">{label}</span>
      <input
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        className="al-input al-input-sm"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </label>
  )
}

function FormNav({
  step,
  total,
  canForward,
  pending,
  onUp,
  onDown,
}: {
  step: number
  total: number
  canForward: boolean
  pending: boolean
  onUp: () => void
  onDown: () => void
}) {
  const pct = Math.round(((step + 1) / total) * 100)
  return (
    <>
      <div className="fixed bottom-6 right-6 z-20 flex items-center gap-3 sm:right-10">
        <span className="al-progress-text">
          {step + 1} / {total}
        </span>
        <div className="flex overflow-hidden rounded-[9px] border border-[var(--al-line)]">
          <button
            type="button"
            className="al-nav"
            onClick={onUp}
            disabled={pending}
            aria-label="Previous"
          >
            <ChevronIcon up />
          </button>
          <span className="w-px self-stretch bg-[var(--al-line)]" />
          <button
            type="button"
            className="al-nav"
            onClick={onDown}
            disabled={pending || !canForward}
            aria-label="Next"
          >
            <ChevronIcon />
          </button>
        </div>
      </div>
      <div className="al-progress-track fixed inset-x-0 bottom-0 z-20">
        <div className="al-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </>
  )
}

/* ---------- icons ---------- */

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8h9M8.5 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.4l3 3L13 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ReturnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13 4v3.5a2 2 0 0 1-2 2H4M6.5 7L4 9.5 6.5 12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon({ up }: { up?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={up ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SealIcon() {
  return (
    <svg width="46" height="46" viewBox="0 0 48 48" fill="none" aria-hidden>
      <circle
        cx="24"
        cy="24"
        r="22"
        stroke="var(--al-accent)"
        strokeWidth="1.4"
        strokeOpacity="0.55"
      />
      <path
        d="M15 24.5l6 6 12-13"
        stroke="var(--al-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StyleBlock() {
  return (
    <style jsx global>{`
      .al-root {
        --al-bg: #08070a;
        --al-ink: #f4f1ea;
        --al-ink-2: rgba(244, 241, 234, 0.62);
        --al-ink-3: rgba(244, 241, 234, 0.42);
        --al-line: rgba(244, 241, 234, 0.16);
        --al-accent: #f0b46a;
        background: var(--al-bg);
        color: var(--al-ink);
        font-feature-settings: 'ss01', 'cv11';
      }
      .al-serif {
        font-family: var(--font-afterlight-serif), Georgia, 'Times New Roman',
          serif;
        font-weight: 400;
      }

      /* Brand mark — a small afterglow orb. */
      .al-orb {
        display: inline-block;
        width: 13px;
        height: 13px;
        border-radius: 9999px;
        background: radial-gradient(
          circle at 35% 32%,
          #ffd9a0 0%,
          #ff9c6b 38%,
          #d4577f 78%
        );
        box-shadow: 0 0 14px 2px rgba(255, 150, 110, 0.55);
        animation: al-orb-pulse 5.5s ease-in-out infinite;
      }
      @keyframes al-orb-pulse {
        0%,
        100% {
          opacity: 0.85;
          transform: scale(1);
        }
        50% {
          opacity: 1;
          transform: scale(1.08);
        }
      }

      /* Animated afterlight glow behind everything. */
      .al-glow {
        overflow: hidden;
      }
      .al-blob {
        position: absolute;
        border-radius: 9999px;
        filter: blur(90px);
        will-change: transform;
      }
      .al-blob-warm {
        width: 58vw;
        height: 58vw;
        left: -8vw;
        top: -12vw;
        background: radial-gradient(
          circle at 40% 40%,
          rgba(255, 154, 102, 0.5),
          rgba(214, 76, 124, 0.28) 45%,
          transparent 70%
        );
        animation: al-drift-warm 26s ease-in-out infinite alternate;
      }
      .al-blob-cool {
        width: 62vw;
        height: 62vw;
        right: -14vw;
        bottom: -18vw;
        background: radial-gradient(
          circle at 60% 60%,
          rgba(140, 110, 255, 0.42),
          rgba(70, 96, 200, 0.24) 48%,
          transparent 72%
        );
        animation: al-drift-cool 32s ease-in-out infinite alternate;
      }
      @keyframes al-drift-warm {
        0% {
          transform: translate3d(0, 0, 0) scale(1);
        }
        100% {
          transform: translate3d(8vw, 6vh, 0) scale(1.14);
        }
      }
      @keyframes al-drift-cool {
        0% {
          transform: translate3d(0, 0, 0) scale(1.05);
        }
        100% {
          transform: translate3d(-7vw, -5vh, 0) scale(0.92);
        }
      }
      .al-glow-bloom .al-blob {
        animation-duration: 8s;
        opacity: 0.85;
      }

      /* Entrance: rise + fade. */
      .al-rise {
        opacity: 0;
        animation: al-rise 760ms cubic-bezier(0.22, 0.68, 0.18, 1) forwards;
      }
      @keyframes al-rise {
        from {
          opacity: 0;
          transform: translateY(18px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* Per-question slide. */
      .al-q-up {
        animation: al-q-up 520ms cubic-bezier(0.22, 0.68, 0.18, 1);
      }
      .al-q-down {
        animation: al-q-down 520ms cubic-bezier(0.22, 0.68, 0.18, 1);
      }
      @keyframes al-q-up {
        from {
          opacity: 0;
          transform: translateY(26px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes al-q-down {
        from {
          opacity: 0;
          transform: translateY(-26px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .al-label {
        font-size: 12px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--al-ink-3);
        font-weight: 500;
      }

      .al-qnum {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 14px;
        font-weight: 600;
        color: var(--al-accent);
      }
      .al-field-label {
        display: block;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--al-ink-3);
        margin-bottom: 10px;
        font-weight: 500;
      }

      /* Typeform-style underline inputs. */
      .al-input {
        width: 100%;
        background: transparent;
        border: 0;
        border-bottom: 1px solid var(--al-line);
        padding: 8px 2px 12px;
        font-size: clamp(1.25rem, 2.6vw, 1.75rem);
        line-height: 1.3;
        color: var(--al-ink);
        caret-color: var(--al-accent);
        outline: none;
        transition: border-color 200ms ease;
        font-family: inherit;
      }
      .al-input-sm {
        font-size: clamp(1.1rem, 2vw, 1.35rem);
      }
      .al-textarea {
        resize: none;
        min-height: 2.6em;
      }
      .al-input::placeholder {
        color: rgba(244, 241, 234, 0.26);
      }
      .al-input:focus {
        border-bottom-color: var(--al-accent);
      }

      /* Typeform-style primary button. */
      .al-btn {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        background: #f6f3ec;
        color: #0a0a0c;
        border: 0;
        border-radius: 11px;
        padding: 13px 22px;
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        cursor: pointer;
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4),
          0 10px 30px -12px rgba(255, 200, 150, 0.45);
        transition: transform 160ms cubic-bezier(0.22, 0.68, 0.18, 1),
          background-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
      }
      .al-btn:hover {
        transform: translateY(-1px);
        background: #ffffff;
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4),
          0 16px 38px -12px rgba(255, 200, 150, 0.6);
      }
      .al-btn:active {
        transform: translateY(0);
      }
      .al-btn:disabled {
        opacity: 0.55;
        cursor: default;
        transform: none;
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
      }

      .al-enter-hint {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 0.82rem;
        color: var(--al-ink-3);
      }
      .al-enter-hint kbd {
        font-family: inherit;
        font-weight: 600;
        color: var(--al-ink-2);
      }

      .al-error {
        font-size: 0.9rem;
        color: #ff9d8a;
      }

      /* Bottom-right nav arrows. */
      .al-nav {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 42px;
        height: 38px;
        background: rgba(244, 241, 234, 0.05);
        color: var(--al-ink-2);
        cursor: pointer;
        transition: background-color 140ms ease, color 140ms ease;
      }
      .al-nav:hover:not(:disabled) {
        background: rgba(244, 241, 234, 0.12);
        color: var(--al-ink);
      }
      .al-nav:disabled {
        opacity: 0.35;
        cursor: default;
      }
      .al-progress-text {
        font-size: 0.78rem;
        color: var(--al-ink-3);
        font-variant-numeric: tabular-nums;
      }

      .al-progress-track {
        height: 3px;
        background: rgba(244, 241, 234, 0.08);
      }
      .al-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #ff9a66, var(--al-accent));
        transition: width 420ms cubic-bezier(0.22, 0.68, 0.18, 1);
      }

      @media (prefers-reduced-motion: reduce) {
        .al-blob,
        .al-orb {
          animation: none !important;
        }
        .al-rise,
        .al-q-up,
        .al-q-down {
          animation-duration: 1ms !important;
        }
        .al-progress-fill {
          transition: none;
        }
      }
    `}</style>
  )
}
