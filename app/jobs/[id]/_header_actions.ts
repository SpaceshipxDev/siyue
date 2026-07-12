'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePartRouteEditor } from '@/lib/auth'
import { updateJob, updateComponent } from '@/lib/db'
import { supabase } from '@/lib/supabase'

// The part card's six facts are AI-extracted from photos — and handwriting
// on a stamp can fool the model (a scribbled 32 reads as 2). Every fact is
// therefore PMC-editable in place; this is the correction valve for the
// extraction layer. Same permission gate as every other job/part edit.

function str(fd: FormData, key: string): string {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

export async function updatePartHeaderAction(formData: FormData): Promise<void> {
  await requirePartRouteEditor()
  const jobId = str(formData, 'jobId')
  const componentId = str(formData, 'componentId')
  const partId = str(formData, 'partId')
  if (!jobId || !componentId) redirect('/')

  const name = str(formData, 'name').slice(0, 120)
  const customer = str(formData, 'customer').slice(0, 60)
  const partNo = str(formData, 'partNo').slice(0, 80)
  const drawingNo = str(formData, 'drawingNo').slice(0, 120)
  const material = str(formData, 'material').slice(0, 60)
  const dueDate = str(formData, 'dueDate')
  const qtyRaw = Number.parseInt(str(formData, 'qty'), 10)
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(qtyRaw, 999_999)) : undefined

  // Single-part photo jobs: the card IS the part, so 名称 updates both the
  // job product and the component name (they render as one identity).
  await updateJob(jobId, {
    ...(name ? { product: name } : {}),
    ...(customer ? { customer } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? { dueDate } : {}),
  })
  await updateComponent(jobId, componentId, {
    ...(name ? { name } : {}),
    ...(qty !== undefined ? { qty } : {}),
    partNo: partNo || null,
    material: material || null,
  })
  if (partId) {
    // drawing_no is a 0083 column outside ComponentPatch — write it directly.
    await supabase.from('parts').update({ drawing_no: drawingNo || null }).eq('id', partId)
  }

  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  redirect(`/jobs/${jobId}`)
}
