// 「第一次沟通」—— 沟通确认单序号那一格。页面和导出的 Excel 共用。

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

function cnNum(n: number): string {
  if (n <= 10) return CN[n]
  if (n < 20) return `十${CN[n - 10]}`
  if (n < 100) return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`
  return String(n)
}

export function roundLabel(i: number): string {
  return `第${cnNum(i + 1)}次沟通`
}
