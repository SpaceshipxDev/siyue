export type OpState = 'pending' | 'working' | 'done'
export type Operation = { name: string; state: OpState; doneQty: number; by?: string; at?: string }
export type PartJob = {
  id: string; customer: string; product: string; drawing: string; qty: number
  material: string; due: string; createdAt: string; urgent?: boolean; operations: Operation[]
}

export const defaultOps = ['编程', 'OP10', 'OP20', '去毛刺', '检验', '后处理']
export const seedJobs: PartJob[] = [
  { id:'YM-0711-008', customer:'禾牧', product:'外卡套', drawing:'BSZ4491.03.02.02.021-VA.1', qty:5, material:'45#', due:'2026-07-13', createdAt:'2026-07-11 08:42', urgent:true, operations:[
    {name:'编程',state:'done',doneQty:5,by:'陈工',at:'07-10 14:20'}, {name:'OP10',state:'working',doneQty:3,by:'王师傅',at:'今天 09:18'}, {name:'OP20',state:'pending',doneQty:0}, {name:'去毛刺',state:'pending',doneQty:0}, {name:'检验',state:'pending',doneQty:0}, {name:'后处理',state:'pending',doneQty:0}] },
  { id:'YM-0711-007', customer:'禾牧', product:'支撑块', drawing:'BSZ4491.03.04.06.010-VA.1', qty:2, material:'45#', due:'2026-07-15', createdAt:'2026-07-11 08:31', operations:[
    {name:'编程',state:'done',doneQty:2}, {name:'OP10',state:'done',doneQty:2}, {name:'OP20',state:'working',doneQty:0,by:'周师傅',at:'今天 08:56'}, {name:'去毛刺',state:'pending',doneQty:0}, {name:'检验',state:'pending',doneQty:0}, {name:'后处理',state:'pending',doneQty:0}] },
  { id:'YM-0710-006', customer:'银方智能', product:'气缸安装板', drawing:'XYZ-04-0018B', qty:12, material:'6061-T6', due:'2026-07-18', createdAt:'2026-07-10 16:04', operations:[
    {name:'编程',state:'done',doneQty:12}, {name:'OP10',state:'done',doneQty:12}, {name:'OP20',state:'done',doneQty:12}, {name:'去毛刺',state:'working',doneQty:7,by:'李师傅',at:'今天 09:04'}, {name:'检验',state:'pending',doneQty:0}, {name:'后处理',state:'pending',doneQty:0}] },
  { id:'YM-0710-005', customer:'创之翼', product:'后侧安装块', drawing:'10142568', qty:20, material:'SS304', due:'2026-07-21', createdAt:'2026-07-10 14:22', operations:[
    {name:'编程',state:'done',doneQty:20}, {name:'OP10',state:'done',doneQty:20}, {name:'OP20',state:'done',doneQty:20}, {name:'去毛刺',state:'done',doneQty:20}, {name:'检验',state:'working',doneQty:16,by:'赵检',at:'今天 08:47'}, {name:'后处理',state:'pending',doneQty:0}] },
  { id:'YM-0710-004', customer:'禾牧', product:'精定位托板2(105)', drawing:'BSZ1279.37.05.008-VA.1', qty:2, material:'6061', due:'2026-07-12', createdAt:'2026-07-10 10:18', urgent:true, operations:[
    {name:'编程',state:'done',doneQty:2}, {name:'OP10',state:'done',doneQty:2}, {name:'OP20',state:'done',doneQty:2}, {name:'去毛刺',state:'done',doneQty:2}, {name:'检验',state:'done',doneQty:2}, {name:'包胶',state:'working',doneQty:0,by:'外协',at:'昨天 17:30'}] },
  { id:'YM-0709-003', customer:'禾牧', product:'压板', drawing:'BSZ3074.06.02.01.114-T-VA.1', qty:24, material:'40Cr', due:'2026-07-12', createdAt:'2026-07-09 15:40', operations:[
    {name:'编程',state:'done',doneQty:24}, {name:'OP10',state:'done',doneQty:24}, {name:'OP20',state:'done',doneQty:24}, {name:'去毛刺',state:'done',doneQty:24}, {name:'检验',state:'done',doneQty:24}, {name:'后处理',state:'done',doneQty:24,by:'刘师傅',at:'今天 08:12'}] },
]

export function currentOp(j: PartJob) { return j.operations.find(o=>o.state==='working') ?? j.operations.find(o=>o.state==='pending') ?? j.operations.at(-1)! }
export function progress(j: PartJob) { return Math.round(j.operations.filter(o=>o.state==='done').length / j.operations.length * 100) }
