// Static shell for /jobs/[id]. Next prefetches this whenever a <Link
// href="/jobs/..."> appears in the viewport, so a click flips to the skeleton
// instantly while the real RSC payload streams in. On a lossy China→Tokyo
// link this is the difference between Chrome's tab spinner running for 10s
// of dead screen vs. a paint within ~50ms.

export default function JobDetailLoading() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="h-[52px] border-b border-[var(--color-border)] bg-[var(--color-surface)]" />
      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <div className="mb-6 flex items-center justify-between gap-3">
          <Bar w={64} h={28} />
          <div className="flex items-center gap-3">
            <Bar w={96} h={28} />
            <Bar w={96} h={28} />
          </div>
        </div>
        <div className="mb-8 grid grid-cols-2 md:grid-cols-12 gap-4 md:gap-8 border-b border-[var(--color-border)] pb-8">
          <div className="col-span-1 md:col-span-2 space-y-2">
            <Bar w={40} h={10} />
            <Bar w={140} h={24} />
          </div>
          <div className="col-span-1 md:col-span-2 space-y-2">
            <Bar w={40} h={10} />
            <Bar w={100} h={16} />
          </div>
          <div className="col-span-2 md:col-span-3 space-y-2">
            <Bar w={120} h={10} />
            <Bar w={140} h={16} />
          </div>
          <div className="col-span-1 md:col-span-2 space-y-2">
            <Bar w={40} h={10} />
            <Bar w={80} h={16} />
          </div>
          <div className="col-span-2 md:col-span-3 space-y-2">
            <Bar w={64} h={10} />
            <Bar w={56} h={16} />
            <div className="h-[2px] w-full bg-[var(--color-border)]" />
          </div>
        </div>
        <div className="mb-3 flex items-baseline justify-between">
          <Bar w={120} h={16} />
          <Bar w={200} h={10} />
        </div>
        <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-3 border-b border-[var(--color-border)] last:border-b-0"
            >
              <Bar w={24} h={12} />
              <div
                className="rounded-sm bg-[var(--color-muted-bg)]"
                style={{ width: 56, height: 56 }}
              />
              <Bar w={160} h={14} />
              <Bar w={48} h={12} />
              <div className="flex-1" />
              <Bar w={320} h={20} />
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

function Bar({ w, h }: { w: number; h: number }) {
  return (
    <div
      className="rounded-sm bg-[var(--color-muted-bg)]"
      style={{ width: w, height: h }}
    />
  )
}
