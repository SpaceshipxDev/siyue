import { NextRequest } from 'next/server'
import { parseWorkbook, type FilePayload } from '@/lib/xlsx'
import { currentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return Response.json({ error: 'no files' }, { status: 400 })
  }

  const results: (FilePayload | { fileName: string; error: string })[] = []
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer()
      results.push(parseWorkbook(buf, file.name))
    } catch (err) {
      results.push({
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return Response.json({ files: results })
}
