import { notFound, redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import { canSeeMoney, canSeeOrderLedger, canSeeReport, requireUser } from '@/lib/auth'
import { getJob } from '@/lib/db'
import { getDrawingFiles } from '@/lib/drawing-file'
import { findPartBalloonSheet } from '@/lib/balloon-store'
import { BalloonUpload } from '../../_balloons'

export const dynamic = 'force-dynamic'

// 零件的气泡图 —— 工单零件那一行「气泡图」点进来的 (检验、质量做检验的地方)。
// 一个零件一张: 做过了直接进那一张; 没做过就在这里拿零件上的图纸生成, 或者当场
// 传 / 粘贴一张图纸截图。
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i

export default async function PartBalloonPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; part?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams
  const jobId = sp.job ?? ''
  const partId = sp.part ?? ''
  const existing = await findPartBalloonSheet(jobId, partId)
  if (existing) redirect(`/quality/balloon/${existing}`)

  const job = jobId ? await getJob(jobId) : null
  const part = job?.components.find((c) => c.id === partId)
  if (!job || !part) notFound()
  const drawings = (await getDrawingFiles(job.id).catch(() => []))
    .filter((d) => d.componentId === part.id && IMAGE.test(d.filename))
    .map((d) => ({ url: d.url, filename: d.filename }))

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="质量"
        subtitle={`气泡图 · ${part.name}`}
        currentTab="质量"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1100px] px-4 md:px-10 py-8 flex-1">
        <p className="mb-1 text-[16px] font-semibold text-[var(--color-ink)]">{part.name}</p>
        <p className="mono mb-5 text-[12.5px] text-[var(--color-ink-3)]">
          {job.jobNo}
          {canSeeMoney(user) && job.customer ? ` · ${job.customer}` : ''}
          {part.material ? ` · ${part.material}` : ''}
        </p>
        <BalloonUpload
          defaultTitle={part.name}
          drawings={drawings}
          link={{
            jobId: job.id,
            componentId: part.id,
            jobNo: job.jobNo,
            customer: canSeeMoney(user) ? job.customer : '',
            material: part.material ?? '',
          }}
        />
      </main>
    </div>
  )
}
