// 人事档案 —— 一个员工一份: 身份证、劳动合同、社保证明、外宿/内宿、个人简历
// (于海伟 2026-10-29)。照片和 PDF 都能传, 点开就看。办了离职的单独放一栏, 档
// 案本身留着, 以后对得上。
//
// 谁看、建档、传、办离职: 人事、商务于海伟、老板。删: 老板和于海伟。
// 身份证这种东西不走公开的图片地址 —— 文件只从 /api/hr-archive 出, 每次都查人。
//
// 纯类型 —— 服务端和客户端共用。存取在 lib/hr-archive.ts。

export type ArchiveKind =
  | 'idcard'
  | 'contract'
  | 'social'
  | 'lodging'
  | 'resume'
  // 离职那三样 (于海伟 2026-10-29)
  | 'resign'
  | 'handover'
  | 'toolReturn'

/** 在职时的五样。 */
export const ARCHIVE_KINDS: readonly ArchiveKind[] = ['idcard', 'contract', 'social', 'lodging', 'resume']

/** 离职时的三样: 离职办理 (离职申请 / 离职单)、工作交接证明、领用工具归还交接证明。 */
export const LEAVE_KINDS: readonly ArchiveKind[] = ['resign', 'handover', 'toolReturn']

export const ARCHIVE_KIND_LABEL: Record<ArchiveKind, string> = {
  idcard: '身份证',
  contract: '劳动合同',
  social: '社保证明',
  lodging: '外宿/内宿',
  resume: '个人简历',
  resign: '离职办理',
  handover: '工作交接证明',
  toolReturn: '领用工具归还交接证明',
}

export type ArchiveFile = {
  id: string
  kind: ArchiveKind
  filename: string
  contentType?: string
  size?: number
  uploadedBy?: string
  createdAt: string
}

export type ArchivePerson = {
  id: string
  name: string
  dept?: string
  /** 住宿 —— 内宿 (住厂里宿舍) / 外宿 */
  lodging?: '内宿' | '外宿'
  note?: string
  files: ArchiveFile[]
  /** 办了离职 —— 哪天 (YYYY-MM-DD), 谁办的。有这个就在「离职」那一栏。 */
  leftAt?: string
  leftBy?: string
  createdBy?: string
  createdAt: string
}

export function isArchiveKind(v: unknown): v is ArchiveKind {
  return typeof v === 'string' && ([...ARCHIVE_KINDS, ...LEAVE_KINDS] as readonly string[]).includes(v)
}

/** 文件从这条路出 —— 每次都查看的人有没有权限。 */
export function archiveFileHref(personId: string, fileId: string): string {
  return `/api/hr-archive?p=${encodeURIComponent(personId)}&f=${encodeURIComponent(fileId)}`
}
