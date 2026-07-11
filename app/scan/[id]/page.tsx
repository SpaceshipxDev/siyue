import { ScanReport } from './scan-report'
export default async function Page({params}:{params:Promise<{id:string}>}){return <ScanReport id={(await params).id}/>}
