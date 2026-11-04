import 'server-only'
import { hrDeptOf, type AuthUser } from './auth'

/*
 * 录入人员的部门 —— 人事 · 考勤。
 *
 * 于海伟 2026-10-12 曾经让录入的人自己选部门 (存在那台机器的 cookie 上)。
 * 于海伟 2026-11-04 改回: 各部门只固定看到自己部门的人, 不能换 —— 部门就是
 * 账号的工段 (hrDeptOf)。账号上的部门不对, 找看全厂的那一档在考勤表上改人的
 * 部门, 或者改账号的工段。
 *
 * 看全厂的那一档 (商务、采购站、于海伟) 不受影响。
 */

export async function filerDeptOf(u: AuthUser): Promise<string> {
  return hrDeptOf(u)
}
