'use client'
import { useState } from 'react'
import { type PartJob } from './yingma-data'

export function JobCreator({onClose,onSave}:{onClose:()=>void,onSave:(j:PartJob)=>void}) {
  const [f,setF]=useState({customer:'禾牧',product:'',drawing:'',qty:'',material:'',due:'2026-07-18'})
  const [ops,setOps]=useState(['编程'])
  const change=(k:string,v:string)=>setF(x=>({...x,[k]:v}))
  const valid=f.customer&&f.product&&f.drawing&&Number(f.qty)>0&&f.due
  const save=()=>onSave({id:'YM-0711-'+String(9+Math.floor(Math.random()*80)).padStart(3,'0'),customer:f.customer,product:f.product,drawing:f.drawing,qty:Number(f.qty),material:f.material,due:f.due,createdAt:'2026-07-11 10:24',operations:ops.map(name=>({name,state:'pending',doneQty:0}))})
  return <div className="ym-overlay"><section className="ym-create">
    <header><div><p className="ym-kicker">新建零件</p><h2>PMC 录基本信息，编程确认工序后打印</h2></div><button className="ym-close" onClick={onClose}>×</button></header>
    <div className="ym-create-body"><div className="ym-form"><h3>基本信息</h3><div className="ym-form-grid">
      <label>客户<input value={f.customer} onChange={e=>change('customer',e.target.value)}/></label>
      <label>产品名称<input autoFocus value={f.product} onChange={e=>change('product',e.target.value)} placeholder="例如：外卡套"/></label>
      <label className="wide">图纸编号<input value={f.drawing} onChange={e=>change('drawing',e.target.value)} placeholder="例如：BSZ4491.03.02.02.021-VA.1"/></label>
      <label>数量<input type="number" value={f.qty} onChange={e=>change('qty',e.target.value)} placeholder="0"/></label>
      <label>材质<input value={f.material} onChange={e=>change('material',e.target.value)} placeholder="45# / 6061 / 40Cr"/></label>
      <label>交期<input type="date" value={f.due} onChange={e=>change('due',e.target.value)}/></label>
    </div><div className="ym-route-head"><h3>预计加工工序</h3><small>可以先不填 · 编程人员确认最终 OP</small></div>
    <div className="ym-route">{ops.map((o,i)=><button key={i} onClick={()=>setOps(x=>x.filter((_,n)=>n!==i))}><i>{i+1}</i>{o}<span>×</span></button>)}<button className="add" onClick={()=>{const o=prompt('输入工序名称');if(o)setOps(x=>[...x,o])}}>＋ 添加工序</button></div></div>
    <aside className="ym-preview"><span>编程确认后打印</span><div className="ym-paper"><header><b>盈玛精密 · 零件随工单</b><small>YM-0711-009</small></header><h2>{f.product||'产品名称'}</h2><p>{f.drawing||'图纸编号'}</p><div className="paper-facts"><span>客户<b>{f.customer||'—'}</b></span><span>数量<b>{f.qty||'—'} 件</b></span><span>材质<b>{f.material||'—'}</b></span><span>交期<b>{f.due.slice(5)||'—'}</b></span></div><div className="paper-route">{ops.map((o,i)=><span key={i}>{i+1}<b>{o}</b></span>)}</div><div className="fake-qr"><i/><i/><i/><i/><b>扫码报工</b></div><small className="paper-help">每道工序完成后，用微信扫码更新数量</small></div></aside></div>
    <footer><button onClick={onClose}>取消</button><button className="ym-primary" disabled={!valid} onClick={save}>保存 · 交给编程</button></footer>
  </section></div>
}
