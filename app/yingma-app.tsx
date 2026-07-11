'use client'
import { useMemo, useState } from 'react'
import { currentOp, defaultOps, progress, seedJobs, type PartJob } from './yingma-data'
import { JobCreator } from './yingma-create'

type Filter = 'all'|'working'|'not-started'|'late'|'done'
export function YingmaApp() {
  const [jobs,setJobs]=useState(seedJobs); const [filter,setFilter]=useState<Filter>('all'); const [q,setQ]=useState(''); const [creating,setCreating]=useState(false); const [selected,setSelected]=useState<PartJob|null>(null)
  const today='2026-07-11'
  const rows=useMemo(()=>jobs.filter(j=>{
    const done=progress(j)===100, started=j.operations.some(o=>o.state!=='pending')
    const ok=filter==='all'||(filter==='working'&&started&&!done)||(filter==='not-started'&&!started)||(filter==='late'&&j.due<today&&!done)||(filter==='done'&&done)
    return ok && `${j.customer}${j.product}${j.drawing}${j.id}`.toLowerCase().includes(q.toLowerCase())
  }),[jobs,filter,q])
  const working=jobs.filter(j=>progress(j)>0&&progress(j)<100).length, late=jobs.filter(j=>j.due<today&&progress(j)<100).length, notStarted=jobs.filter(j=>progress(j)===0).length
  return <div className="ym-shell">
    <header className="ym-header"><div className="ym-brand"><span className="ym-mark">盈</span><div><strong>盈玛生产跟单</strong><small>每个零件，现在做到哪一步</small></div></div><nav><button className="active">生产进度</button><button>已完成</button><button>人员</button></nav><div className="ym-user">PMC · 小吴 <span>吴</span></div></header>
    <main className="ym-main">
      <section className="ym-heading"><div><p className="ym-kicker">7月11日 · 周六</p><h1>生产进度</h1><p>不用下车间，也知道每个零件做到哪一步。</p></div><button className="ym-primary" onClick={()=>setCreating(true)}><b>＋</b> 新建零件</button></section>
      <section className="ym-metrics">
        <button className={filter==='working'?'on':''} onClick={()=>setFilter('working')}><span>正在加工</span><strong>{working}</strong><em>个零件正在流转</em></button>
        <button className={filter==='not-started'?'on':''} onClick={()=>setFilter('not-started')}><span>还未开始</span><strong>{notStarted}</strong><em>等待第一道工序</em></button>
        <button className={filter==='late'?'on danger':''} onClick={()=>setFilter('late')}><span>已经逾期</span><strong>{late}</strong><em>{late?'需要马上处理':'当前没有逾期'}</em></button>
        <div className="ym-activity"><span>刚刚更新</span><b>王师傅</b><p>外卡套 · OP10 完成 3 / 5 件</p><time>4 分钟前</time></div>
      </section>
      <section className="ym-board">
        <div className="ym-toolbar"><div className="ym-tabs">{([['all','全部'],['working','正在加工'],['not-started','还未开始'],['late','逾期'],['done','已完成']] as [Filter,string][]).map(([k,v])=><button key={k} className={filter===k?'active':''} onClick={()=>setFilter(k)}>{v}{k==='all'&&<i>{jobs.length}</i>}</button>)}</div><label className="ym-search">⌕<input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜客户、产品或图号"/></label></div>
        <div className="ym-table-wrap"><table className="ym-table"><thead><tr><th>零件</th><th>客户</th><th>数量</th><th>交期</th><th>当前工序</th><th>工序进度</th><th>最后更新</th><th></th></tr></thead><tbody>{rows.map(j=>{const op=currentOp(j),p=progress(j),over=j.due<today&&p<100; return <tr key={j.id} onClick={()=>setSelected(j)}><td><b>{j.product}</b><small>{j.drawing}</small></td><td>{j.customer}</td><td className="mono">{j.qty} 件</td><td className={over?'over':''}>{j.due.slice(5).replace('-','月')}日{over&&<small>逾期</small>}</td><td><span className={`ym-status ${p===100?'done':op.state}`}>{p===100?'已完成':op.state==='working'?'加工中':'未开始'}</span><b className="ym-op">{p===100?'全部工序':op.name}</b>{op.state==='working'&&op.doneQty>0&&<small>{op.doneQty} / {j.qty} 件</small>}</td><td><div className="ym-progress"><i style={{width:`${p}%`}}/></div><small>{j.operations.filter(o=>o.state==='done').length} / {j.operations.length}</small></td><td><b>{op.by??'—'}</b><small>{op.at??j.createdAt.slice(5)}</small></td><td><button className="ym-more">•••</button></td></tr>})}</tbody></table></div>
        <footer className="ym-footer">显示 {rows.length} 个零件 <span>状态来自车间扫码报工 · 自动刷新</span></footer>
      </section>
    </main>
    {creating&&<JobCreator onClose={()=>setCreating(false)} onSave={j=>{setJobs(x=>[j,...x]);setCreating(false)}}/>}
    {selected&&<JobDrawer job={selected} onClose={()=>setSelected(null)}/>} 
  </div>
}

function JobDrawer({job,onClose}:{job:PartJob,onClose:()=>void}){return <div className="ym-overlay" onMouseDown={onClose}><aside className="ym-drawer" onMouseDown={e=>e.stopPropagation()}><button className="ym-close" onClick={onClose}>×</button><p className="ym-kicker">{job.id}</p><h2>{job.product}</h2><p className="ym-drawing">{job.drawing}</p><div className="ym-facts"><span>客户<b>{job.customer}</b></span><span>数量<b>{job.qty} 件</b></span><span>材质<b>{job.material}</b></span><span>交期<b>{job.due}</b></span></div><h3>工序进度</h3><ol className="ym-timeline">{job.operations.map((o,i)=><li key={i} className={o.state}><i>{o.state==='done'?'✓':i+1}</i><div><b>{o.name}</b><small>{o.state==='done'?`已完成 ${job.qty} 件`:o.state==='working'?`正在加工 · 已完成 ${o.doneQty} / ${job.qty} 件`:'等待前序完成'}</small></div><time>{o.by}<br/>{o.at}</time></li>)}</ol><div className="ym-drawer-actions"><a href={`/scan/${job.id}`}>模拟扫码报工</a><button onClick={()=>window.print()}>打印随工单</button></div></aside></div>}
