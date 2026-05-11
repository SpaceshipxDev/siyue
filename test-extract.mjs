// Reproduce the runExtraction flow against the failed file, isolated from
// db + storage so we see if Gemini is the culprit.
// no dotenv
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { unzipSync, strFromU8 } from 'fflate'
import { GoogleGenAI, Type } from '@google/genai'

// Inline copies of the relevant helpers so we don't need to compile TS
function decodeXmlEntities(s) {
  return s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
}
function colLettersToIndex(letters){let n=0;for(const ch of letters)n=n*26+(ch.charCodeAt(0)-64);return n-1}
function parseCellAddr(addr){const m=/^([A-Z]+)(\d+)$/.exec(addr);return m?{row:parseInt(m[2],10)-1,col:colLettersToIndex(m[1])}:null}
function dirOf(p){const i=p.lastIndexOf('/');return i<0?'':p.slice(0,i)}
function relsPathFor(docPath){const dir=dirOf(docPath);const base=docPath.slice(dir.length+(dir?1:0));return `${dir?dir+'/':''}_rels/${base}.rels`}
function resolveRel(docDir,target){const parts=(docDir.replace(/\/?$/,'/')+target).split('/');const out=[];for(const p of parts){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p)}return out.join('/')}
function parseRels(xml){const rels=[];const re=/<Relationship\b[^>]*\/>/g;let m;while((m=re.exec(xml))){const t=m[0];const id=/\bId="([^"]+)"/.exec(t)?.[1];const type=/\bType="([^"]+)"/.exec(t)?.[1];const target=/\bTarget="([^"]+)"/.exec(t)?.[1];if(id&&type&&target)rels.push({id,type,target})}return rels}
function parseSheetIndex(workbookXml,workbookRels){const byId=new Map(workbookRels.map(r=>[r.id,r]));const sheets=[];const re=/<sheet\b[^>]*\/>/g;let m;while((m=re.exec(workbookXml))){const t=m[0];const name=/\bname="([^"]+)"/.exec(t)?.[1];const rid=/\br:id="([^"]+)"/.exec(t)?.[1];if(!name||!rid)continue;const rel=byId.get(rid);if(!rel)continue;sheets.push({name:decodeXmlEntities(name),path:resolveRel('xl',rel.target)})}return sheets}
function parseDispimgCells(sheetXml){const out=[];const re=/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>\s*<f[^>]*>([^<]*)<\/f>/g;let m;while((m=re.exec(sheetXml))){const addr=m[1];const formula=decodeXmlEntities(m[2]);const idMatch=/DISPIMG\(\s*"([^"]+)"/.exec(formula);if(idMatch)out.push({addr,imageId:idMatch[1]})}return out}
function parseCellImagesIndex(xml){const out=new Map();const re=/<etc:cellImage\b[\s\S]*?<\/etc:cellImage>/g;let m;while((m=re.exec(xml))){const block=m[0];const name=/\bname="(ID_[^"]+)"/.exec(block)?.[1];const embed=/\br:embed="([^"]+)"/.exec(block)?.[1];if(name&&embed)out.set(name,embed)}return out}

function extractWorkbookImages(buf){
  const zip=unzipSync(new Uint8Array(buf))
  const text=k=>zip[k]?strFromU8(zip[k]):null
  const workbookXml=text('xl/workbook.xml')
  const workbookRelsXml=text('xl/_rels/workbook.xml.rels')
  if(!workbookXml||!workbookRelsXml)return{anchors:[],images:new Map()}
  const sheets=parseSheetIndex(workbookXml,parseRels(workbookRelsXml))
  const images=new Map()
  const refByMediaPath=new Map()
  let refSeq=0
  const refFor=mediaPath=>{const c=refByMediaPath.get(mediaPath);if(c)return c;const u8=zip[mediaPath];if(!u8)return null;refSeq+=1;const ref=`img${refSeq}`;images.set(ref,{ref,bytes:u8});refByMediaPath.set(mediaPath,ref);return ref}
  const cellImagesXml=text('xl/cellimages.xml')
  const cellImagesRelsXml=text('xl/_rels/cellimages.xml.rels')
  const dispimgRefById=new Map()
  if(cellImagesXml&&cellImagesRelsXml){
    const idToRel=parseCellImagesIndex(cellImagesXml)
    const relTargets=new Map(parseRels(cellImagesRelsXml).map(r=>[r.id,r.target]))
    for(const[id,embed] of idToRel){const target=relTargets.get(embed);if(!target)continue;const mediaPath=resolveRel('xl',target);const ref=refFor(mediaPath);if(ref)dispimgRefById.set(id,ref)}
  }
  const anchors=[]
  for(const sheet of sheets){
    const sheetXml=text(sheet.path);if(!sheetXml)continue
    if(dispimgRefById.size>0){
      for(const cell of parseDispimgCells(sheetXml)){
        const ref=dispimgRefById.get(cell.imageId)
        const pos=parseCellAddr(cell.addr)
        if(!ref||!pos)continue
        anchors.push({sheet:sheet.name,row:pos.row,col:pos.col,imageRef:ref})
      }
    }
  }
  return{anchors,images}
}

function annotateSheetWithImages(sheetName,aoa,anchors){
  for(const a of anchors){
    if(a.sheet!==sheetName)continue
    while(aoa.length<=a.row)aoa.push([])
    const row=aoa[a.row]
    while(row.length<=a.col)row.push(null)
    row[a.col]=`<<IMG:${a.imageRef}>>`
  }
  return aoa
}

const fileName='YNMX-26-4-1-008.xlsx'
const buf=readFileSync('/Users/hashashin/Downloads/'+fileName)
const wb=XLSX.read(buf,{type:'buffer',cellDates:true})
const sheets=wb.SheetNames.map(name=>{
  const ws=wb.Sheets[name]
  const aoa=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:false,blankrows:true})
  return{name,aoa}
})
const{anchors,images}=extractWorkbookImages(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))
const annotated=sheets.map(s=>({name:s.name,aoa:annotateSheetWithImages(s.name,s.aoa,anchors)}))
const imageRefs=[...images.keys()]
console.log('imageRefs count:',imageRefs.length)
console.log('anchors count:',anchors.length)

const userPrompt=[
  `文件名: ${fileName}`,'',
  '可用图片引用 (imageRef 必须从中选取，否则 null):',
  imageRefs.length>0?imageRefs.map(r=>`- ${r}`).join('\n'):'(无)',
  '',
  'Excel 工作表内容（每个工作表为二维数组，按行/列）。',
  '"<<IMG:imgN>>" 表示该单元格在原 Excel 中嵌入了一张图片：',
  JSON.stringify(annotated,null,2),
].join('\n')
console.log('prompt length:', userPrompt.length, 'chars')

const SCHEMA={type:Type.OBJECT,properties:{
  jobNo:{type:Type.STRING},customer:{type:Type.STRING},product:{type:Type.STRING},
  amountCny:{type:Type.NUMBER,nullable:true},dueDate:{type:Type.STRING,nullable:true},notes:{type:Type.STRING,nullable:true},
  parts:{type:Type.ARRAY,items:{type:Type.OBJECT,properties:{
    name:{type:Type.STRING},qty:{type:Type.INTEGER},
    material:{type:Type.STRING,nullable:true},surfaceTreatment:{type:Type.STRING,nullable:true},
    notes:{type:Type.STRING,nullable:true},unitPriceCny:{type:Type.NUMBER,nullable:true},
    lineTotalCny:{type:Type.NUMBER,nullable:true},imageRef:{type:Type.STRING,nullable:true},
  },required:['name','qty']}}
},required:['jobNo','customer','product','parts']}

const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})
const t0=Date.now()
try {
  const response=await ai.models.generateContent({
    model:'gemini-3.1-flash-lite-preview',
    contents:userPrompt,
    config:{
      systemInstruction:'你是一名工厂订单录入助手。从 Excel 抽取一张工单 (Job) 及其零件列表 (parts)。仅输出 JSON。',
      responseMimeType:'application/json',
      responseSchema:SCHEMA,
      temperature:0.1,
    },
  })
  const ms=Date.now()-t0
  const text=response.text
  console.log(`gemini OK in ${ms}ms, text length=${text?.length ?? 0}`)
  if (text) {
    const parsed = JSON.parse(text)
    console.log('jobNo:', parsed.jobNo)
    console.log('customer:', parsed.customer)
    console.log('product:', parsed.product)
    console.log('parts:', parsed.parts?.length)
  } else {
    console.log('response keys:', Object.keys(response))
    console.log('response:', JSON.stringify(response, null, 2).slice(0, 4000))
  }
} catch (e) {
  console.error('GEMINI FAILED after', Date.now()-t0,'ms')
  console.error(e?.message || e)
  console.error(e?.stack)
}
