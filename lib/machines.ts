import 'server-only'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { supabase } from './supabase'

export const MACHINE_STATES = [
  'programming',
  'ready',
  'idle',
  'offline',
  'error',
  'unknown',
] as const

export type MachineState = (typeof MACHINE_STATES)[number]

export const EXECUTION_STATES = ['running', 'paused', 'stopped', 'unknown'] as const
export type MachineExecutionState = (typeof EXECUTION_STATES)[number]

export const WORK_SIGNALS = ['controller_cycle', 'controller_cutting_timer', 'mtconnect_execution', 'program_activity', 'unavailable'] as const
export type MachineWorkSignal = (typeof WORK_SIGNALS)[number]

export const TELEMETRY_SOURCES = ['controller_macro', 'controller_macro_auto', 'mtconnect', 'unavailable'] as const
export type MachineTelemetrySource = (typeof TELEMETRY_SOURCES)[number]

export type MachineOperation = {
  number: number
  tool: number | null
  depthMm: number | null
  durationSeconds: number | null
  cutter: string | null
}

export type RecentMachineProgram = {
  name: string
  sizeBytes: number
  modifiedAt: string | null
}

export type MachineDiscoveredService = {
  port: number
  name: string
  latencyMs: number
}

export type MachineCapability = {
  readable: boolean
  source: string
  note: string
}

export type MachineWireSnapshot = {
  id: string
  name: string
  ip: string
  connected: boolean
  state: MachineState
  observedAt: string
  jobStartedAt: string | null
  currentProgram: string | null
  programFingerprint: string | null
  programModifiedAt: string | null
  programSizeBytes: number | null
  programCount: number
  mainProgramCount: number
  programNumber: string | null
  sourcePart: string | null
  sourcePartPath: string | null
  controller: string | null
  camProgrammedAt: string | null
  estimatedDurationSeconds: number | null
  operationCount: number | null
  currentOperation: number | null
  operations: MachineOperation[]
  toolNumbers: number[]
  spindleRpm: number | null
  feedMmMin: number | null
  completedParts: number | null
  totalCompletedParts: number | null
  targetParts: number | null
  currentCycleSeconds: number | null
  currentCuttingSeconds: number | null
  controllerBootCycleSeconds: number | null
  cuttingTodaySeconds: number
  telemetrySource: MachineTelemetrySource
  runtimeObservedAt: string | null
  runtimeLatencyMs: number | null
  runtimeError: string | null
  discoveryStatus: string
  discoveryConfidence: number
  discoveredServices: MachineDiscoveredService[]
  executionState: MachineExecutionState
  workSignal: MachineWorkSignal
  workDay: string
  workedTodaySeconds: number
  onlineTodaySeconds: number
  currentCycleStartedAt: string | null
  ftpLatencyMs: number | null
  recentPrograms: RecentMachineProgram[]
  manufacturer: string | null
  model: string | null
  driver: string
  capabilities: Record<string, MachineCapability>
  discoveryNotes: string[]
  programSource: string | null
  programSourceTruncated: boolean
  programSourceSha256: string | null
  programSourceCapturedAt: string | null
  error: string | null
}

export type MachineIngest = {
  watcherId: string
  watcherVersion: string
  observedAt: string
  machines: MachineWireSnapshot[]
}

export type MachineView = MachineWireSnapshot & {
  lastSeenAt: string | null
  collectorId: string
  collectorVersion: string
  updatedAt: string
}

export type MachineEventView = {
  id: string
  machineId: string
  eventType: 'first_seen' | 'program_changed' | 'state_changed' | 'connected' | 'disconnected'
  observedAt: string
  state: MachineState
  programName: string | null
  sourcePart: string | null
}

type SnapshotRow = {
  machine_id: string
  machine_name: string
  ip_address: string
  connected: boolean
  state: MachineState
  observed_at: string
  last_seen_at: string | null
  job_started_at: string | null
  current_program: string | null
  program_fingerprint: string | null
  program_modified_at: string | null
  program_size_bytes: number | null
  program_count: number
  main_program_count: number
  program_number: string | null
  source_part: string | null
  source_part_path: string | null
  controller: string | null
  cam_programmed_at: string | null
  estimated_duration_seconds: number | null
  operation_count: number | null
  current_operation: number | null
  operations: MachineOperation[] | null
  tool_numbers: number[] | null
  spindle_rpm: number | null
  feed_mm_min: number | null
  completed_parts: number | null
  total_completed_parts: number | null
  target_parts: number | null
  current_cycle_seconds: number | null
  current_cutting_seconds: number | null
  controller_boot_cycle_seconds: number | null
  cutting_today_seconds: number
  telemetry_source: MachineTelemetrySource
  runtime_observed_at: string | null
  runtime_latency_ms: number | null
  runtime_error: string | null
  discovery_status: string
  discovery_confidence: number
  discovered_services: MachineDiscoveredService[] | null
  execution_state: MachineExecutionState
  work_signal: MachineWorkSignal
  work_day: string
  worked_today_seconds: number
  online_today_seconds: number
  current_cycle_started_at: string | null
  ftp_latency_ms: number | null
  recent_programs: RecentMachineProgram[] | null
  manufacturer: string | null
  model: string | null
  driver: string
  capabilities: Record<string, MachineCapability> | null
  discovery_notes: string[] | null
  program_source: string | null
  program_source_truncated: boolean
  program_source_sha256: string | null
  program_source_captured_at: string | null
  collector_id: string
  collector_version: string
  error: string | null
  updated_at: string
}

type MachineFileStore = {
  version: 1
  machines: Record<string, MachineView>
  events: MachineEventView[]
}

const MAX_MACHINES = 128
const MAX_TEXT = 1_000
const MAX_PROGRAM_SOURCE = 262_144
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

export function machineTokenMatches(request: Request): boolean {
  const expected = process.env.MACHINE_INGEST_TOKEN
  if (!expected || expected.length < 24) return false
  const authorization = request.headers.get('authorization') ?? ''
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : ''
  const a = Buffer.from(expected)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function machineDashboardProxyMatches(headers: Pick<Headers, 'get'>): boolean {
  const expected = process.env.MACHINE_DASHBOARD_PROXY_KEY
  if (!expected || expected.length < 24) return false
  const supplied = headers.get('x-yingma-machine-dashboard') ?? ''
  const a = Buffer.from(expected)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function parseMachineIngest(input: unknown): MachineIngest {
  const root = record(input, 'payload')
  const watcherId = requiredId(root.watcherId, 'watcherId')
  const watcherVersion = requiredText(root.watcherVersion, 'watcherVersion', 60)
  const observedAt = requiredDate(root.observedAt, 'observedAt')
  if (!Array.isArray(root.machines) || root.machines.length < 1 || root.machines.length > MAX_MACHINES) {
    throw new Error(`machines must contain 1-${MAX_MACHINES} items`)
  }

  return {
    watcherId,
    watcherVersion,
    observedAt,
    machines: root.machines.map((item, index) => parseMachine(item, index)),
  }
}

function parseMachine(input: unknown, index: number): MachineWireSnapshot {
  const row = record(input, `machines[${index}]`)
  const state = requiredText(row.state, `machines[${index}].state`, 30)
  if (!(MACHINE_STATES as readonly string[]).includes(state)) {
    throw new Error(`machines[${index}].state is invalid`)
  }
  const executionState = requiredText(row.executionState, `machines[${index}].executionState`, 30)
  if (!(EXECUTION_STATES as readonly string[]).includes(executionState)) {
    throw new Error(`machines[${index}].executionState is invalid`)
  }
  const workSignal = requiredText(row.workSignal, `machines[${index}].workSignal`, 40)
  if (!(WORK_SIGNALS as readonly string[]).includes(workSignal)) {
    throw new Error(`machines[${index}].workSignal is invalid`)
  }
  const rawTelemetrySource = row.telemetrySource ?? 'unavailable'
  const telemetrySource = requiredText(rawTelemetrySource, `machines[${index}].telemetrySource`, 40)
  if (!(TELEMETRY_SOURCES as readonly string[]).includes(telemetrySource)) {
    throw new Error(`machines[${index}].telemetrySource is invalid`)
  }
  return {
    id: requiredId(row.id, `machines[${index}].id`),
    name: requiredText(row.name, `machines[${index}].name`, 120),
    ip: requiredText(row.ip, `machines[${index}].ip`, 80),
    connected: requiredBoolean(row.connected, `machines[${index}].connected`),
    state: state as MachineState,
    observedAt: requiredDate(row.observedAt, `machines[${index}].observedAt`),
    jobStartedAt: nullableDate(row.jobStartedAt, `machines[${index}].jobStartedAt`),
    currentProgram: nullableText(row.currentProgram),
    programFingerprint: nullableText(row.programFingerprint, 200),
    programModifiedAt: nullableDate(row.programModifiedAt, `machines[${index}].programModifiedAt`),
    programSizeBytes: nullableNumber(row.programSizeBytes, 0),
    programCount: requiredNumber(row.programCount, 0),
    mainProgramCount: requiredNumber(row.mainProgramCount, 0),
    programNumber: nullableText(row.programNumber, 80),
    sourcePart: nullableText(row.sourcePart, 260),
    sourcePartPath: nullableText(row.sourcePartPath),
    controller: nullableText(row.controller, 200),
    camProgrammedAt: nullableDate(row.camProgrammedAt, `machines[${index}].camProgrammedAt`),
    estimatedDurationSeconds: nullableNumber(row.estimatedDurationSeconds, 0),
    operationCount: nullableNumber(row.operationCount, 0),
    currentOperation: nullableNumber(row.currentOperation, 0),
    operations: parseOperations(row.operations),
    toolNumbers: numberArray(row.toolNumbers, 80),
    spindleRpm: nullableNumber(row.spindleRpm, 0),
    feedMmMin: nullableNumber(row.feedMmMin, 0),
    completedParts: nullableNumber(row.completedParts, 0),
    totalCompletedParts: nullableNumber(row.totalCompletedParts, 0),
    targetParts: nullableNumber(row.targetParts, 0),
    currentCycleSeconds: nullableNumber(row.currentCycleSeconds, 0),
    currentCuttingSeconds: nullableNumber(row.currentCuttingSeconds, 0),
    controllerBootCycleSeconds: nullableNumber(row.controllerBootCycleSeconds, 0),
    cuttingTodaySeconds: optionalNumber(row.cuttingTodaySeconds, 0, 0),
    telemetrySource: telemetrySource as MachineTelemetrySource,
    runtimeObservedAt: nullableDate(row.runtimeObservedAt, `machines[${index}].runtimeObservedAt`),
    runtimeLatencyMs: nullableNumber(row.runtimeLatencyMs, 0),
    runtimeError: nullableText(row.runtimeError),
    discoveryStatus: optionalText(row.discoveryStatus, 'not_started', 80),
    discoveryConfidence: optionalNumber(row.discoveryConfidence, 0, 0),
    discoveredServices: parseDiscoveredServices(row.discoveredServices),
    executionState: executionState as MachineExecutionState,
    workSignal: workSignal as MachineWorkSignal,
    workDay: requiredDay(row.workDay, `machines[${index}].workDay`),
    workedTodaySeconds: requiredNumber(row.workedTodaySeconds, 0),
    onlineTodaySeconds: requiredNumber(row.onlineTodaySeconds, 0),
    currentCycleStartedAt: nullableDate(row.currentCycleStartedAt, `machines[${index}].currentCycleStartedAt`),
    ftpLatencyMs: nullableNumber(row.ftpLatencyMs, 0),
    recentPrograms: parseRecentPrograms(row.recentPrograms),
    manufacturer: nullableText(row.manufacturer, 160),
    model: nullableText(row.model, 160),
    driver: optionalText(row.driver, 'inventory', 40),
    capabilities: parseCapabilities(row.capabilities),
    discoveryNotes: textArray(row.discoveryNotes, 20, 500),
    programSource: nullableText(row.programSource, MAX_PROGRAM_SOURCE),
    programSourceTruncated: optionalBoolean(row.programSourceTruncated, false),
    programSourceSha256: nullableText(row.programSourceSha256, 64),
    programSourceCapturedAt: nullableDate(row.programSourceCapturedAt, `machines[${index}].programSourceCapturedAt`),
    error: nullableText(row.error),
  }
}

function parseOperations(value: unknown): MachineOperation[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).map((item, index) => {
    const op = record(item, `operations[${index}]`)
    return {
      number: requiredNumber(op.number, 0),
      tool: nullableNumber(op.tool, 0),
      depthMm: nullableNumber(op.depthMm),
      durationSeconds: nullableNumber(op.durationSeconds, 0),
      cutter: nullableText(op.cutter, 240),
    }
  })
}

function parseRecentPrograms(value: unknown): RecentMachineProgram[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map((item, index) => {
    const program = record(item, `recentPrograms[${index}]`)
    return {
      name: requiredText(program.name, `recentPrograms[${index}].name`, 260),
      sizeBytes: requiredNumber(program.sizeBytes, 0),
      modifiedAt: nullableDate(program.modifiedAt, `recentPrograms[${index}].modifiedAt`),
    }
  })
}

function parseDiscoveredServices(value: unknown): MachineDiscoveredService[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).map((item, index) => {
    const service = record(item, `discoveredServices[${index}]`)
    return {
      port: requiredNumber(service.port, 1),
      name: requiredText(service.name, `discoveredServices[${index}].name`, 80),
      latencyMs: requiredNumber(service.latencyMs, 0),
    }
  })
}

function parseCapabilities(value: unknown): Record<string, MachineCapability> {
  if (value == null) return {}
  const input = record(value, 'capabilities')
  return Object.fromEntries(Object.entries(input).slice(0, 20).map(([key, raw]) => {
    const capability = record(raw, `capabilities.${key}`)
    return [requiredId(key, 'capability key'), {
      readable: requiredBoolean(capability.readable, `capabilities.${key}.readable`),
      source: requiredText(capability.source, `capabilities.${key}.source`, 80),
      note: requiredText(capability.note, `capabilities.${key}.note`, 500),
    }]
  }))
}

export async function ingestMachineSnapshots(payload: MachineIngest): Promise<void> {
  if (process.env.MACHINE_STORE_MODE === 'file') {
    await ingestMachineFile(payload)
    return
  }
  try {
    await ingestMachineDatabase(payload)
  } catch (error) {
    if (!isMissingMachineTable(error)) throw error
    await ingestMachineFile(payload)
  }
}

async function ingestMachineDatabase(payload: MachineIngest): Promise<void> {
  const ids = payload.machines.map((machine) => machine.id)
  const { data: existingData, error: existingError } = await supabase
    .from('machine_snapshots')
    .select('*')
    .in('machine_id', ids)
  if (existingError) throw existingError

  const existing = new Map(
    ((existingData ?? []) as SnapshotRow[]).map((row) => [row.machine_id, row]),
  )
  const now = new Date().toISOString()
  const rows = payload.machines.map((machine) => {
    const before = existing.get(machine.id)
    const sameJob = Boolean(before && before.current_program === machine.currentProgram)
    const jobStartedAt = machine.currentProgram
      ? sameJob
        ? before?.job_started_at ?? machine.jobStartedAt ?? machine.observedAt
        : machine.jobStartedAt ?? machine.programModifiedAt ?? machine.observedAt
      : null
    return {
      machine_id: machine.id,
      machine_name: machine.name,
      ip_address: machine.ip,
      connected: machine.connected,
      state: machine.state,
      observed_at: machine.observedAt,
      last_seen_at: machine.connected ? machine.observedAt : before?.last_seen_at ?? null,
      job_started_at: jobStartedAt,
      current_program: machine.currentProgram,
      program_fingerprint: machine.programFingerprint,
      program_modified_at: machine.programModifiedAt,
      program_size_bytes: machine.programSizeBytes,
      program_count: machine.programCount,
      main_program_count: machine.mainProgramCount,
      program_number: machine.programNumber,
      source_part: machine.sourcePart,
      source_part_path: machine.sourcePartPath,
      controller: machine.controller,
      cam_programmed_at: machine.camProgrammedAt,
      estimated_duration_seconds: machine.estimatedDurationSeconds,
      operation_count: machine.operationCount,
      current_operation: machine.currentOperation,
      operations: machine.operations,
      tool_numbers: machine.toolNumbers,
      spindle_rpm: machine.spindleRpm,
      feed_mm_min: machine.feedMmMin,
      completed_parts: machine.completedParts,
      total_completed_parts: machine.totalCompletedParts,
      target_parts: machine.targetParts,
      current_cycle_seconds: machine.currentCycleSeconds,
      current_cutting_seconds: machine.currentCuttingSeconds,
      controller_boot_cycle_seconds: machine.controllerBootCycleSeconds,
      cutting_today_seconds: machine.cuttingTodaySeconds,
      telemetry_source: machine.telemetrySource,
      runtime_observed_at: machine.runtimeObservedAt,
      runtime_latency_ms: machine.runtimeLatencyMs,
      runtime_error: machine.runtimeError,
      discovery_status: machine.discoveryStatus,
      discovery_confidence: machine.discoveryConfidence,
      discovered_services: machine.discoveredServices,
      execution_state: machine.executionState,
      work_signal: machine.workSignal,
      work_day: machine.workDay,
      worked_today_seconds: machine.workedTodaySeconds,
      online_today_seconds: machine.onlineTodaySeconds,
      current_cycle_started_at: machine.currentCycleStartedAt,
      ftp_latency_ms: machine.ftpLatencyMs,
      recent_programs: machine.recentPrograms,
      manufacturer: machine.manufacturer,
      model: machine.model,
      driver: machine.driver,
      capabilities: machine.capabilities,
      discovery_notes: machine.discoveryNotes,
      program_source: machine.programSource ?? (sameJob ? before?.program_source ?? null : null),
      program_source_truncated: machine.programSource == null && sameJob
        ? before?.program_source_truncated ?? false
        : machine.programSourceTruncated,
      program_source_sha256: machine.programSourceSha256 ?? (sameJob ? before?.program_source_sha256 ?? null : null),
      program_source_captured_at: machine.programSourceCapturedAt ?? (sameJob ? before?.program_source_captured_at ?? null : null),
      collector_id: payload.watcherId,
      collector_version: payload.watcherVersion,
      error: machine.error,
      updated_at: now,
    }
  })

  const { error: upsertError } = await supabase
    .from('machine_snapshots')
    .upsert(rows, { onConflict: 'machine_id' })
  if (upsertError) throw upsertError

  const events = payload.machines.flatMap((machine) => {
    const before = existing.get(machine.id)
    const eventType = changedEvent(before, machine)
    if (!eventType) return []
    return [{
      id: randomUUID(),
      machine_id: machine.id,
      event_type: eventType,
      observed_at: machine.observedAt,
      state: machine.state,
      program_name: machine.currentProgram,
      source_part: machine.sourcePart,
      summary: {
        operationCount: machine.operationCount,
        estimatedDurationSeconds: machine.estimatedDurationSeconds,
        programSizeBytes: machine.programSizeBytes,
      },
    }]
  })
  if (events.length > 0) {
    const { error } = await supabase.from('machine_events').insert(events)
    if (error) throw error
  }
}

function changedEvent(
  before: SnapshotRow | undefined,
  machine: MachineWireSnapshot,
): MachineEventView['eventType'] | null {
  if (!before) return 'first_seen'
  if (before.connected !== machine.connected) return machine.connected ? 'connected' : 'disconnected'
  if (before.current_program !== machine.currentProgram) return 'program_changed'
  if (before.state !== machine.state) return 'state_changed'
  return null
}

export async function getMachineDashboard(): Promise<{
  machines: MachineView[]
  events: MachineEventView[]
  serverTime: string
}> {
  if (process.env.MACHINE_STORE_MODE === 'file') return getMachineFileDashboard()
  try {
    return await getMachineDatabaseDashboard()
  } catch (error) {
    if (!isMissingMachineTable(error)) throw error
    return getMachineFileDashboard()
  }
}

async function getMachineDatabaseDashboard(): Promise<{
  machines: MachineView[]
  events: MachineEventView[]
  serverTime: string
}> {
  const [snapshotResult, eventResult] = await Promise.all([
    supabase.from('machine_snapshots').select('*').order('machine_id'),
    supabase
      .from('machine_events')
      .select('id, machine_id, event_type, observed_at, state, program_name, source_part')
      .order('observed_at', { ascending: false })
      .limit(40),
  ])
  if (snapshotResult.error) throw snapshotResult.error
  if (eventResult.error) throw eventResult.error

  return {
    machines: ((snapshotResult.data ?? []) as SnapshotRow[]).map(toMachineView),
    events: (eventResult.data ?? []).map((row) => ({
      id: String(row.id),
      machineId: String(row.machine_id),
      eventType: row.event_type as MachineEventView['eventType'],
      observedAt: String(row.observed_at),
      state: row.state as MachineState,
      programName: row.program_name ? String(row.program_name) : null,
      sourcePart: row.source_part ? String(row.source_part) : null,
    })),
    serverTime: new Date().toISOString(),
  }
}

const MACHINE_STORE_PATH = process.env.MACHINE_STORE_PATH ||
  path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'machines.json')

async function readMachineFile(): Promise<MachineFileStore> {
  try {
    const parsed = JSON.parse(await readFile(MACHINE_STORE_PATH, 'utf8')) as MachineFileStore
    if (parsed?.version !== 1 || !parsed.machines || !Array.isArray(parsed.events)) {
      throw new Error('machine telemetry file has an invalid format')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, machines: {}, events: [] }
    }
    throw error
  }
}

async function writeMachineFile(store: MachineFileStore): Promise<void> {
  await mkdir(path.dirname(MACHINE_STORE_PATH), { recursive: true })
  const temporary = `${MACHINE_STORE_PATH}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, MACHINE_STORE_PATH)
}

async function ingestMachineFile(payload: MachineIngest): Promise<void> {
  const store = await readMachineFile()
  const updatedAt = new Date().toISOString()

  for (const machine of payload.machines) {
    const before = store.machines[machine.id]
    const sameJob = Boolean(before && before.currentProgram === machine.currentProgram)
    const jobStartedAt = machine.currentProgram
      ? sameJob
        ? before.jobStartedAt ?? machine.jobStartedAt ?? machine.observedAt
        : machine.jobStartedAt ?? machine.programModifiedAt ?? machine.observedAt
      : null
    const eventType = changedFileEvent(before, machine)

    const preservedProgramSource = machine.programSource ?? (sameJob ? before?.programSource ?? null : null)
    store.machines[machine.id] = {
      ...machine,
      programSource: preservedProgramSource,
      programSourceTruncated: machine.programSource == null && sameJob
        ? before?.programSourceTruncated ?? false
        : machine.programSourceTruncated,
      programSourceSha256: machine.programSourceSha256 ?? (sameJob ? before?.programSourceSha256 ?? null : null),
      programSourceCapturedAt: machine.programSourceCapturedAt ?? (sameJob ? before?.programSourceCapturedAt ?? null : null),
      jobStartedAt,
      lastSeenAt: machine.connected ? machine.observedAt : before?.lastSeenAt ?? null,
      collectorId: payload.watcherId,
      collectorVersion: payload.watcherVersion,
      updatedAt,
    }

    if (eventType) {
      store.events.unshift({
        id: randomUUID(),
        machineId: machine.id,
        eventType,
        observedAt: machine.observedAt,
        state: machine.state,
        programName: machine.currentProgram,
        sourcePart: machine.sourcePart,
      })
    }
  }

  store.events = store.events
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, 200)
  await writeMachineFile(store)
}

async function getMachineFileDashboard(): Promise<{
  machines: MachineView[]
  events: MachineEventView[]
  serverTime: string
}> {
  const store = await readMachineFile()
  return {
    machines: Object.values(store.machines).sort((a, b) => a.id.localeCompare(b.id)),
    events: store.events.slice(0, 40),
    serverTime: new Date().toISOString(),
  }
}

function changedFileEvent(
  before: MachineView | undefined,
  machine: MachineWireSnapshot,
): MachineEventView['eventType'] | null {
  if (!before) return 'first_seen'
  if (before.connected !== machine.connected) return machine.connected ? 'connected' : 'disconnected'
  if (before.currentProgram !== machine.currentProgram) return 'program_changed'
  if (before.state !== machine.state) return 'state_changed'
  return null
}

function isMissingMachineTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === '42P01' ||
    (typeof candidate.message === 'string' && candidate.message.includes('machine_snapshots'))
}

function toMachineView(row: SnapshotRow): MachineView {
  return {
    id: row.machine_id,
    name: row.machine_name,
    ip: row.ip_address,
    connected: row.connected,
    state: row.state,
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
    jobStartedAt: row.job_started_at,
    currentProgram: row.current_program,
    programFingerprint: row.program_fingerprint,
    programModifiedAt: row.program_modified_at,
    programSizeBytes: row.program_size_bytes,
    programCount: row.program_count,
    mainProgramCount: row.main_program_count,
    programNumber: row.program_number,
    sourcePart: row.source_part,
    sourcePartPath: row.source_part_path,
    controller: row.controller,
    camProgrammedAt: row.cam_programmed_at,
    estimatedDurationSeconds: row.estimated_duration_seconds,
    operationCount: row.operation_count,
    currentOperation: row.current_operation,
    operations: row.operations ?? [],
    toolNumbers: row.tool_numbers ?? [],
    spindleRpm: row.spindle_rpm,
    feedMmMin: row.feed_mm_min,
    completedParts: row.completed_parts,
    totalCompletedParts: row.total_completed_parts,
    targetParts: row.target_parts,
    currentCycleSeconds: row.current_cycle_seconds,
    currentCuttingSeconds: row.current_cutting_seconds,
    controllerBootCycleSeconds: row.controller_boot_cycle_seconds,
    cuttingTodaySeconds: row.cutting_today_seconds,
    telemetrySource: row.telemetry_source,
    runtimeObservedAt: row.runtime_observed_at,
    runtimeLatencyMs: row.runtime_latency_ms,
    runtimeError: row.runtime_error,
    discoveryStatus: row.discovery_status,
    discoveryConfidence: row.discovery_confidence,
    discoveredServices: row.discovered_services ?? [],
    executionState: row.execution_state,
    workSignal: row.work_signal,
    workDay: row.work_day,
    workedTodaySeconds: row.worked_today_seconds,
    onlineTodaySeconds: row.online_today_seconds,
    currentCycleStartedAt: row.current_cycle_started_at,
    ftpLatencyMs: row.ftp_latency_ms,
    recentPrograms: row.recent_programs ?? [],
    manufacturer: row.manufacturer,
    model: row.model,
    driver: row.driver ?? 'inventory',
    capabilities: row.capabilities ?? {},
    discoveryNotes: row.discovery_notes ?? [],
    programSource: row.program_source,
    programSourceTruncated: row.program_source_truncated ?? false,
    programSourceSha256: row.program_source_sha256,
    programSourceCapturedAt: row.program_source_captured_at,
    error: row.error,
    collectorId: row.collector_id,
    collectorVersion: row.collector_version,
    updatedAt: row.updated_at,
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredId(value: unknown, label: string): string {
  const text = requiredText(value, label, 80)
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function requiredText(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string up to ${max} characters`)
  }
  return value.trim()
}

function nullableText(value: unknown, max = MAX_TEXT): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error('text field is invalid')
  return value.trim().slice(0, max) || null
}

function optionalText(value: unknown, fallback: string, max = MAX_TEXT): string {
  if (value == null || value === '') return fallback
  return requiredText(value, 'text field', max)
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback
  if (typeof value !== 'boolean') throw new Error('boolean field is invalid')
  return value
}

function textArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, maximumItems).map((item) => requiredText(item, 'text array item', maximumLength))
}

function requiredNumber(value: unknown, min?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (min != null && value < min)) {
    throw new Error('number field is invalid')
  }
  return value
}

function nullableNumber(value: unknown, min?: number): number | null {
  if (value == null || value === '') return null
  return requiredNumber(value, min)
}

function optionalNumber(value: unknown, fallback: number, min?: number): number {
  if (value == null || value === '') return fallback
  return requiredNumber(value, min)
}

function requiredDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date`)
  }
  return new Date(value).toISOString()
}

function nullableDate(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  return requiredDate(value, label)
}

function requiredDay(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`)
  }
  return value
}

function numberArray(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, max)
    .map((item) => requiredNumber(item))
}
