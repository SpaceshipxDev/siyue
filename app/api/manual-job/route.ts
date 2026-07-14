import { revalidatePath } from 'next/cache'
import { currentUser, canEditProductionFields } from '@/lib/auth'
import { CNC_OP_STAGES, type Stage } from '@/lib/data'
import { confirmJob, createJob, deleteJob, setPartRoute } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ManualJobBody = {
  customer?: unknown
  partNo?: unknown
  name?: unknown
  drawingNo?: unknown
  qty?: unknown
  dueDate?: unknown
  stages?: unknown
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function manualJobNo(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()
  return `YM-${stamp}-${suffix}`
}

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: ManualJobBody
  try {
    body = (await request.json()) as ManualJobBody
  } catch {
    return Response.json({ ok: false, error: '请求格式错误' }, { status: 400 })
  }

  const customer = text(body.customer, 160)
  const partNo = text(body.partNo, 100)
  const name = text(body.name, 200)
  const drawingNo = text(body.drawingNo, 120)
  const dueDate = text(body.dueDate, 10)
  const qty = Number(body.qty)
  const requestedStages = Array.isArray(body.stages) ? body.stages : []
  const stages = CNC_OP_STAGES.filter((stage) => requestedStages.includes(stage))

  if (!customer) {
    return Response.json({ ok: false, error: '请填写客户名称' }, { status: 400 })
  }
  if (!partNo) {
    return Response.json({ ok: false, error: '请填写货号' }, { status: 400 })
  }
  if (!name) {
    return Response.json({ ok: false, error: '请填写描述' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(`${dueDate}T00:00:00Z`))) {
    return Response.json({ ok: false, error: '请选择有效交期' }, { status: 400 })
  }
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 10_000_000) {
    return Response.json({ ok: false, error: '数量必须是大于 0 的整数' }, { status: 400 })
  }

  let jobId: string | undefined
  try {
    const job = await createJob({
      jobNo: manualJobNo(),
      customer,
      product: name,
      dueDate,
      sourceFile: '手工新建',
      components: [
        {
          name,
          qty,
          partNo,
          drawingNo: drawingNo || undefined,
        },
      ],
    })
    jobId = job.id

    const route = await setPartRoute(job.id, job.components[0].id, [
      ...(stages as Stage[]),
      '检验',
      '出货',
    ])
    if (!route.ok) throw new Error('工序保存失败')

    await confirmJob(job.id)
    revalidatePath('/')
    return Response.json({ ok: true, jobId: job.id })
  } catch (error) {
    if (jobId) {
      try {
        await deleteJob(jobId)
      } catch (cleanupError) {
        console.error('[manual-job] cleanup failed:', cleanupError)
      }
    }
    console.error('[manual-job] failed:', error)
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : '新建失败' },
      { status: 500 },
    )
  }
}
