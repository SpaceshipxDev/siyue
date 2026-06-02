import { notFound, redirect } from 'next/navigation'
import { getJob, parseJobNoConflictError } from '@/lib/db'
import {
  canEditProductionFields,
  landingPathFor,
  requireUser,
  type AuthUser,
} from '@/lib/auth'
import { TopBar } from '@/app/_ui'
import { BackButton } from '@/app/_back'
import {
  ComponentLineTotal,
  ComponentNotes,
  ComponentQty,
  ComponentText,
  ComponentUnitPrice,
  JobAmount,
  JobDueDate,
  JobSecondaryDueDate,
  JobNotes,
  JobText,
} from '@/app/_editable'
import { BatchPhotoUploader } from '@/app/_batch_photo_uploader'
import { ComponentImageUploader } from '@/app/_image_uploader'
import {
  AddComponentButton,
  ConfirmImportButton,
  DeleteComponentButton,
} from '@/app/_import_actions'
import { ParsingPoller } from '@/app/_import_status'
import { SourceFileRow } from '@/app/_source_file'
import { StageChips } from '@/app/_stagechips'
import type { Component } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function ImportReview(props: PageProps<'/import/[id]'>) {
  // Commerce + 工程 head both run imports.
  const user = await requireUser()
  if (!canEditProductionFields(user)) redirect(landingPathFor(user))
  const { id } = await props.params
  const job = await getJob(id)
  if (!job) notFound()
  if (job.status === 'ready') redirect(`/jobs/${job.id}`)
  if (job.status === 'parsing' || job.status === 'failed') {
    const conflict =
      job.status === 'failed' ? parseJobNoConflictError(job.parseError) : null
    return (
      <ParsingScreen
        jobId={job.id}
        sourceFile={job.sourceFile}
        hasSourceFile={Boolean(job.sourceFileUrl)}
        failed={job.status === 'failed'}
        error={conflict ? undefined : job.parseError}
        conflict={conflict}
        user={user}
      />
    )
  }

  const withImage = job.components.filter((c) => c.imageUrl).length

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={`${job.jobNo} · ${job.product}`}
        subtitle="导入审核 · 草稿"
        currentTab={user.defaultStage === '工程' ? '工程' : '商务'}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <div className="mb-6 flex items-center justify-between">
          <BackButton fallback="/" />
          <span className="label text-[var(--color-ink-3)]">
            {withImage}/{job.components.length} 已配图
          </span>
        </div>

        <div className="mb-6 rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-[12px] text-[var(--color-ink)]">
          AI 已自动抽取以下内容 · 请逐项核对、补全图片，确认后才会进入看板。
        </div>

        <div className="mb-6">
          <SourceFileRow
            jobId={job.id}
            fileName={job.sourceFile}
            url={job.sourceFileUrl}
          />
        </div>

        <div className="mb-8 grid grid-cols-2 md:grid-cols-12 gap-4 md:gap-8 border-b border-[var(--color-border)] pb-8">
          <div className="col-span-2 md:col-span-3">
            <p className="label mb-1">客户</p>
            <JobText
              jobId={job.id}
              field="customer"
              value={job.customer}
              multiline
              className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]"
              placeholder="客户"
            />
            <div className="mt-1">
              <JobText
                jobId={job.id}
                field="product"
                value={job.product}
                className="text-[14px] text-[var(--color-ink-2)]"
                placeholder="产品"
              />
            </div>
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-2">工号</p>
            <JobText
              jobId={job.id}
              field="jobNo"
              value={job.jobNo}
              mono
              className="text-[15px] text-[var(--color-ink)]"
              placeholder="工号"
            />
          </div>
          <div className="col-span-2 md:col-span-3">
            <p className="label mb-2">金额</p>
            <div className="flex items-baseline gap-1">
              <span className="mono text-[15px] text-[var(--color-ink-3)]">¥</span>
              <JobAmount
                jobId={job.id}
                value={job.amountCny}
                className="text-[15px] font-medium text-[var(--color-ink)]"
              />
            </div>
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-2">交期</p>
            <JobDueDate
              jobId={job.id}
              value={job.dueDate}
              className="text-[15px] text-[var(--color-ink)]"
            />
            <p className="label mb-2 mt-3">二次交期</p>
            <JobSecondaryDueDate
              jobId={job.id}
              value={job.secondaryDueDate}
              className="text-[15px] text-[var(--color-ink)]"
            />
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-2">零件数</p>
            <p className="mono text-[15px] text-[var(--color-ink)]">
              {job.components.length}
            </p>
          </div>
        </div>

        <div className="mb-6">
          <p className="label mb-2">工单备注</p>
          <JobNotes
            jobId={job.id}
            value={job.notes}
            placeholder="添加备注…"
            className="text-[13px] text-[var(--color-ink)]"
          />
        </div>

        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            零件清单
          </h2>
          <p className="label">
            点击图框上传 · 字段可直接编辑 · 工段路线默认全部经过，点击关闭不需要的
          </p>
        </div>

        {job.components.length > 0 ? (
          <div className="mb-3">
            <BatchPhotoUploader
              jobId={job.id}
              components={job.components.map((c) => ({
                id: c.id,
                name: c.name,
                imageUrl: c.imageUrl,
              }))}
            />
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="sheet w-full text-left text-[13px]">
            <colgroup>
              <col style={{ width: 56 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 160 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 220 }} />
              <col style={{ minWidth: 200 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 70 }} />
            </colgroup>
            <thead>
              <tr className="text-[var(--color-ink-2)]">
                <th className="px-3 py-3 text-center label whitespace-nowrap">#</th>
                <th className="px-3 py-3 label whitespace-nowrap">图</th>
                <th className="px-4 py-3 label whitespace-nowrap">零件名称</th>
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  数量
                </th>
                <th className="px-4 py-3 label whitespace-nowrap">材料</th>
                <th className="px-4 py-3 label whitespace-nowrap">表面处理</th>
                <th className="px-4 py-3 label whitespace-nowrap">工序</th>
                <th className="px-4 py-3 label whitespace-nowrap">备注</th>
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  单价
                </th>
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  小计
                </th>
                <th className="px-3 py-3 label whitespace-nowrap" />
              </tr>
            </thead>
            <tbody>
              {job.components.map((c, i) => (
                <ImportComponentRows
                  key={c.id}
                  index={i}
                  jobId={job.id}
                  component={c}
                />
              ))}
              {job.components.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-6 text-center text-[12px] text-[var(--color-ink-3)]"
                  >
                    无零件 · 添加一行开始
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
            <AddComponentButton jobId={job.id} />
          </div>
        </div>

        <div className="mt-10 flex items-center justify-end gap-4">
          <span className="label text-[var(--color-ink-3)]">
            确认后工单进入主看板 · 选「发往工段」可直接送入指定工段队列
          </span>
          <ConfirmImportButton jobId={job.id} />
        </div>
      </main>
    </div>
  )
}

function ImportComponentRows({
  index,
  jobId,
  component,
}: {
  index: number
  jobId: string
  component: Component
}) {
  return (
    <tr className="align-middle">
      <td className="px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]">
        {String(index + 1).padStart(2, '0')}
      </td>
      <td className="px-3 py-2">
        <ComponentImageUploader
          jobId={jobId}
          componentId={component.id}
          imageUrl={component.imageUrl}
          size={64}
        />
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={component.id}
          field="name"
          value={component.name}
          placeholder="零件名称"
          className="text-[14px] font-medium text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentQty
          jobId={jobId}
          componentId={component.id}
          value={component.qty}
          className="text-[13px] text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={component.id}
          field="material"
          value={component.material}
          placeholder="材料"
          className="text-[12px] text-[var(--color-ink-2)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={component.id}
          field="surfaceTreatment"
          value={component.surfaceTreatment}
          placeholder="表面处理"
          className="text-[12px] text-[var(--color-ink-2)]"
        />
      </td>
      <td className="px-3 py-3">
        <StageChips jobId={jobId} component={component} />
      </td>
      <td className="px-3 py-3">
        <ComponentNotes
          jobId={jobId}
          componentId={component.id}
          value={component.notes}
          placeholder="添加备注…"
          className="text-[12px] text-[var(--color-ink-2)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentUnitPrice
          jobId={jobId}
          componentId={component.id}
          value={component.unitPriceCny}
          className="text-[13px] text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentLineTotal
          jobId={jobId}
          componentId={component.id}
          value={component.lineTotalCny}
          className="text-[13px] text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3 text-center">
        <DeleteComponentButton
          jobId={jobId}
          componentId={component.id}
          componentName={component.name}
        />
      </td>
    </tr>
  )
}

function ParsingScreen({
  jobId,
  sourceFile,
  hasSourceFile,
  failed,
  error,
  conflict,
  user,
}: {
  jobId: string
  sourceFile?: string
  hasSourceFile: boolean
  failed: boolean
  error?: string
  conflict: { id: string; jobNo: string; customer: string } | null
  user: AuthUser
}) {
  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={sourceFile ? `导入 · ${sourceFile}` : '导入'}
        subtitle={
          conflict ? '工号已存在' : failed ? '解析失败' : 'AI 解析中'
        }
        currentTab={user.defaultStage === '工程' ? '工程' : '商务'}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />

      <main className="mx-auto w-full max-w-[900px] px-4 md:px-10 py-8 md:py-16 flex-1">
        <div className="mb-8">
          <BackButton fallback="/" />
        </div>

        <ParsingPoller
          jobId={jobId}
          sourceFile={sourceFile}
          failed={failed}
          error={error}
          conflict={conflict}
          hasSourceFile={hasSourceFile}
        />
      </main>
    </div>
  )
}
