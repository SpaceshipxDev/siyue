import {
  canSeeOrderLedger,
  canSeeReport,
  canUploadDrawing,
  canWriteNcProgram,
  requireUser,
  canClickStage,
} from '@/lib/auth'
import { getStationQueue, getJobsComponents } from '@/lib/db'
import { getDrawingFiles } from '@/lib/drawing-file'
import { getNcPrograms } from '@/lib/nc-program-store'
import { findReusable, reuseKey, type NcProgram } from '@/lib/nc-program'
import { partRef } from '@/lib/data'
import type { DrawingFile } from '@/lib/drawing'
import { TopBar } from '@/app/_ui'
import { ProgrammingDesk, type DeskRow } from './_desk'

export const dynamic = 'force-dynamic'

// 编程台 —— 编程员自己的一页。
//
// 工段看板回答的是"这批活走到哪一站了", 每个工段一个样子。编程的活跟操机不
// 一样: 操机是一件一件做完, 编程是一个件出一套程序 —— 做之前要看图、看材料、
// 看以前编过没有, 做完要把程序号交给操机。这些东西原来散在工单明细页里, 编
// 程员得在看板和工单之间来回跑。
//
// 所以这一页把三件事收在一行上: 要编什么 · 图和料 · 出程序并报完成。
// 排序按交期 —— 编程是整条流水的头, 它压一天, 后面每一站都压一天。

export default async function ProgrammingDeskPage() {
  const user = await requireUser()

  const queue = await getStationQueue('编程')
  // 已完成的那一段不进这一页 —— 编程台是"还要编什么"的清单, 编完了它就该从
  // 眼前消失 (要翻旧账去工段看板)。
  const live = queue.filter((it) => it.status !== 'done')

  const jobIds = [...new Set(live.map((it) => it.jobId))]
  // 图纸清单是一张工单一份, 所以只读眼前这几张工单的 —— 待编的工单通常十几
  // 张, 并行读一次就够, 不去翻全厂。
  const [drawingLists, allPrograms, componentsByJob] = await Promise.all([
    Promise.all(jobIds.map((id) => getDrawingFiles(id))),
    getNcPrograms(),
    getJobsComponents(jobIds),
  ])

  const drawings: DrawingFile[] = drawingLists.flat()
  // 键是 partRef (工单 + 零件)。零件编号只在一张工单里唯一 (p1/p2/p3), 这一
  // 页摆的是几十张工单 —— 按编号归会把全厂每张工单的第一个零件混成一个。
  const byPart = new Map<string, NcProgram[]>()
  for (const p of allPrograms) {
    const k = partRef(p.jobId, p.componentId)
    byPart.set(k, [...(byPart.get(k) ?? []), p])
  }
  // 零件的材质 / 料号 / 图片 —— 队列里没有, 从工单的零件表补齐。编程员要读的
  // 就是这几样。
  const partMeta = new Map<
    string,
    { partNo?: string; material?: string; process?: string; surfaceTreatment?: string; imageUrl?: string }
  >()
  for (const [jobId, list] of componentsByJob) {
    for (const c of list) {
      partMeta.set(partRef(jobId, c.id), {
        partNo: c.partNo,
        material: c.material,
        process: c.process,
        surfaceTreatment: c.surfaceTreatment,
        imageUrl: c.imageUrl,
      })
    }
  }

  const rows: DeskRow[] = live.map((it) => {
    const ref = partRef(it.jobId, it.componentId)
    const meta = partMeta.get(ref) ?? {}
    const mine = byPart.get(ref) ?? []
    return {
      jobId: it.jobId,
      jobNo: it.jobNo,
      product: it.product,
      dueDate: it.dueDate,
      status: it.status,
      componentId: it.componentId,
      name: it.componentName,
      qty: it.qty,
      note: it.componentNote,
      partNo: meta.partNo,
      material: meta.material,
      process: meta.process,
      surfaceTreatment: meta.surfaceTreatment,
      imageUrl: meta.imageUrl,
      programs: mine,
      reusable:
        mine.length > 0
          ? []
          : findReusable(
              allPrograms,
              reuseKey({ name: it.componentName, partNo: meta.partNo }),
              it.jobId,
            ),
    }
  })

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title="编程"
        subtitle="看图 · 出程序 · 报完成"
        currentTab="编程"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <ProgrammingDesk
        rows={rows}
        drawings={drawings}
        canUpload={canUploadDrawing(user)}
        canWrite={canWriteNcProgram(user)}
        canReport={canClickStage(user, '编程')}
      />
    </div>
  )
}
