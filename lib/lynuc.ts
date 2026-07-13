import 'server-only'

import net from 'node:net'

const CONNECT_TIMEOUT_MS = 2_500
const COMMAND_TIMEOUT_MS = 4_000
const programAnalysisCache = new Map<string, LynucProgram>()

export type LynucProgram = {
  name: string
  sizeBytes: number
  modifiedAt: string | null
  blockCount: number | null
  toolNumbers: number[]
  spindleCommands: number[]
  feedCommands: number[]
  programNumber: string | null
  camSource: string | null
}

export type LynucMachineSnapshot = {
  id: string
  name: string
  ip: string
  connected: boolean
  sampledAt: string
  latencyMs: number | null
  error: string | null
  programCount: number
  latestProgram: LynucProgram | null
  recentPrograms: Array<Pick<LynucProgram, 'name' | 'sizeBytes' | 'modifiedAt'>>
  telemetry: {
    executionState: null
    currentProgram: null
    completedParts: null
    targetParts: null
    runSeconds: null
    cuttingSeconds: null
    actualSpindleRpm: null
    actualFeedMmMin: null
    currentTool: null
    alarm: null
  }
}

type FtpEntry = {
  name: string
  sizeBytes: number
  modifiedAt: string | null
  type: string
}

type Reply = { code: number; text: string }

class ReadOnlyFtpClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private replies: Array<(reply: Reply) => void> = []

  constructor(private readonly host: string) {}

  async connect(): Promise<void> {
    const socket = net.createConnection({ host: this.host, port: 21 })
    this.socket = socket
    socket.setEncoding('utf8')
    socket.setTimeout(COMMAND_TIMEOUT_MS)
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', () => undefined)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), CONNECT_TIMEOUT_MS)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    const hello = await this.readReply()
    if (hello.code !== 220) throw new Error(`FTP ${hello.code}`)
    const userReply = await this.expect('USER anonymous', [331, 230])
    if (userReply.code === 331) await this.expect('PASS machine-kit@localhost', [230])
    await this.expect('TYPE I', [200])
  }

  async list(): Promise<FtpEntry[]> {
    const data = await this.passiveTransfer('MLSD')
    return data
      .split(/\r?\n/)
      .map(parseMlsdLine)
      .filter((entry): entry is FtpEntry => entry !== null)
  }

  async retrieve(name: string, maxBytes = 3_000_000): Promise<string> {
    if (!/^[^/\\\r\n]+$/.test(name)) throw new Error('非法文件名')
    const data = await this.passiveTransfer(`RETR ${name}`, maxBytes)
    return data
  }

  close(): void {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write('QUIT\r\n')
    this.socket.end()
  }

  private async passiveTransfer(command: string, maxBytes = 5_000_000): Promise<string> {
    const passive = await this.command('EPSV')
    if (passive.code !== 229) throw new Error(`EPSV ${passive.code}`)
    const match = passive.text.match(/\(\|\|\|(\d+)\|\)/)
    if (!match) throw new Error('EPSV 响应无端口')
    const port = Number(match[1])
    const chunks: Buffer[] = []
    let bytes = 0
    const dataSocket = net.createConnection({ host: this.host, port })
    dataSocket.setTimeout(COMMAND_TIMEOUT_MS)
    const dataDone = new Promise<string>((resolve, reject) => {
      dataSocket.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= maxBytes) chunks.push(chunk)
      })
      dataSocket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      dataSocket.once('timeout', () => reject(new Error('数据读取超时')))
      dataSocket.once('error', reject)
    })

    const start = await this.command(command)
    if (start.code !== 125 && start.code !== 150) {
      dataSocket.destroy()
      throw new Error(`${command.split(' ')[0]} ${start.code}`)
    }
    const data = await dataDone
    const finish = await this.readReply()
    if (finish.code !== 226) throw new Error(`传输 ${finish.code}`)
    return data
  }

  private async expect(command: string, codes: number[]): Promise<Reply> {
    const reply = await this.command(command)
    if (!codes.includes(reply.code)) throw new Error(`${command.split(' ')[0]} ${reply.code}`)
    return reply
  }

  private async command(command: string): Promise<Reply> {
    if (!this.socket || this.socket.destroyed) throw new Error('FTP 未连接')
    const reply = this.readReply()
    this.socket.write(`${command}\r\n`)
    return reply
  }

  private readReply(): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FTP 响应超时')), COMMAND_TIMEOUT_MS)
      this.replies.push((reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.flushReplies()
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    this.flushReplies()
  }

  private flushReplies(): void {
    while (this.replies.length > 0) {
      const parsed = parseReply(this.buffer)
      if (!parsed) return
      this.buffer = this.buffer.slice(parsed.consumed)
      this.replies.shift()?.({ code: parsed.code, text: parsed.text })
    }
  }
}

function parseReply(buffer: string): (Reply & { consumed: number }) | null {
  const firstEnd = buffer.indexOf('\n')
  if (firstEnd < 0) return null
  const first = buffer.slice(0, firstEnd + 1)
  const match = first.match(/^(\d{3})([ -])/)
  if (!match) return null
  const code = Number(match[1])
  if (match[2] === ' ') return { code, text: first.trim(), consumed: firstEnd + 1 }
  const terminator = `\n${match[1]} `
  const finalStart = buffer.indexOf(terminator, firstEnd)
  if (finalStart < 0) return null
  const finalEnd = buffer.indexOf('\n', finalStart + 1)
  if (finalEnd < 0) return null
  return {
    code,
    text: buffer.slice(0, finalEnd + 1).trim(),
    consumed: finalEnd + 1,
  }
}

function parseMlsdLine(line: string): FtpEntry | null {
  const separator = line.indexOf(' ')
  if (separator < 0) return null
  const facts = Object.fromEntries(
    line
      .slice(0, separator)
      .split(';')
      .filter(Boolean)
      .map((fact) => {
        const index = fact.indexOf('=')
        return [fact.slice(0, index).toLowerCase(), fact.slice(index + 1)]
      }),
  )
  const name = line.slice(separator + 1).trim()
  if (!name) return null
  return {
    name,
    type: facts.type ?? 'unknown',
    sizeBytes: Number(facts.size ?? 0),
    modifiedAt: parseFtpTimestamp(facts.modify),
  }
}

function parseFtpTimestamp(value?: string): string | null {
  if (!value || !/^\d{14}/.test(value)) return null
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function analyzeProgram(
  entry: FtpEntry,
  content: string,
): LynucProgram {
  const tools = uniqueNumbers(content.matchAll(/(?:^|\s)T(\d+)\b/g))
  const spindle = uniqueNumbers(content.matchAll(/(?:^|\s)S(\d+(?:\.\d+)?)\b/g))
  const feed = uniqueNumbers(content.matchAll(/(?:^|\s)F(\d+(?:\.\d+)?)\b/g))
  const program = content.match(/(?:^|\n)\s*(O\d+)\b/i)?.[1] ?? null
  const camSource =
    content.match(/\((?:PartFileName\d*|Part File Name)\s*=\s*([^\r\n)]+)\)/i)?.[1]?.trim() ??
    null
  const blocks = content
    .split(/\r?\n/)
    .filter((line) => {
      const clean = line.trim()
      return clean && clean !== '%' && !clean.startsWith('(')
    }).length

  return {
    name: entry.name,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    blockCount: blocks,
    toolNumbers: tools,
    spindleCommands: spindle,
    feedCommands: feed,
    programNumber: program,
    camSource,
  }
}

function uniqueNumbers(matches: IterableIterator<RegExpMatchArray>): number[] {
  return [...new Set([...matches].map((match) => Number(match[1])).filter(Number.isFinite))].slice(0, 24)
}

const MACHINES = [
  { id: 'lynuc-01', name: 'LYNUC 01', ip: process.env.LYNUC_MACHINE_1_IP ?? '192.168.10.140' },
  { id: 'lynuc-02', name: 'LYNUC 02', ip: process.env.LYNUC_MACHINE_2_IP ?? '192.168.10.141' },
] as const

export async function readLynucMachines(): Promise<LynucMachineSnapshot[]> {
  return Promise.all(MACHINES.map(readMachine))
}

async function readMachine(machine: (typeof MACHINES)[number]): Promise<LynucMachineSnapshot> {
  const sampledAt = new Date().toISOString()
  const startedAt = performance.now()
  const client = new ReadOnlyFtpClient(machine.ip)
  try {
    await client.connect()
    const latencyMs = Math.round(performance.now() - startedAt)
    const entries = (await client.list())
      .filter((entry) => entry.type === 'file' && /\.(?:nc|txt)$/i.test(entry.name))
      .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
    const latest = entries[0] ?? null
    let latestProgram: LynucProgram | null = null
    if (latest) {
      const cacheKey = `${machine.ip}:${latest.name}:${latest.modifiedAt}:${latest.sizeBytes}`
      latestProgram = programAnalysisCache.get(cacheKey) ?? null
      if (!latestProgram) {
        const content = await client.retrieve(latest.name)
        latestProgram = analyzeProgram(latest, content)
        programAnalysisCache.clear()
        programAnalysisCache.set(cacheKey, latestProgram)
      }
    }
    return {
      ...machine,
      connected: true,
      sampledAt,
      latencyMs,
      error: null,
      programCount: entries.length,
      latestProgram,
      recentPrograms: entries.slice(0, 8).map(({ name, sizeBytes, modifiedAt }) => ({
        name,
        sizeBytes,
        modifiedAt,
      })),
      telemetry: unavailableTelemetry(),
    }
  } catch (error) {
    return {
      ...machine,
      connected: false,
      sampledAt,
      latencyMs: null,
      error: error instanceof Error ? error.message : '读取失败',
      programCount: 0,
      latestProgram: null,
      recentPrograms: [],
      telemetry: unavailableTelemetry(),
    }
  } finally {
    client.close()
  }
}

function unavailableTelemetry(): LynucMachineSnapshot['telemetry'] {
  return {
    executionState: null,
    currentProgram: null,
    completedParts: null,
    targetParts: null,
    runSeconds: null,
    cuttingSeconds: null,
    actualSpindleRpm: null,
    actualFeedMmMin: null,
    currentTool: null,
    alarm: null,
  }
}
