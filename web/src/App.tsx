import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Box,
  Braces,
  Cable,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Copy,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  GitBranch,
  Info,
  Layers3,
  LoaderCircle,
  MapPinned,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'

type GraphNode = {
  id: string
  label: string
  signature: string
  filePath: string | null
  relativePath: string | null
  line: number | null
  column: number | null
  documentVersion?: number | null
  kind: 'definition' | 'external' | string
}

type GraphEdge = {
  id: string
  source: string
  target: string
  callSites: Array<{ line: number | null; column: number | null }>
}

type Graph = {
  analyzer?: string
  relativePath?: string
  focusNodeId?: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  limitations?: string[]
  truncated?: boolean
  omittedExternalCallCount?: number
  oversizedFunctionCount?: number
  performance?: { cacheHit?: boolean; totalMs?: number; analyzedFunctionCount?: number }
  semanticStatus?: 'available' | 'noEvidence' | 'notReady' | 'unsupported' | 'timeout' | 'failed' | 'demo'
  statusSummary?: string
  statusDetail?: string
}

type WorkbenchContext = {
  workspaceRoot?: string
  filePath?: string
  dictionaryId?: string
  dictionaryName?: string
  runRecordId?: string
  dataRevision?: string
  requestedTime?: string
  focusLine?: string
  focusColumn?: string
  documentVersion?: number
  windowSessionId?: string
}

type EditorSemanticResponse = {
  status?: string
  result?: Graph
  error?: string
}

type FunctionRole = 'current' | 'caller' | 'callee' | 'linked' | 'external'
type FlowData = GraphNode & { selected: boolean; degree: number; role: FunctionRole; reduceMotion: boolean }
type WorkspaceView = 'function' | 'modules' | 'integrations'
type FunctionTab = 'overview' | 'calls' | 'time' | 'evidence'
type ModuleFunction = { functionName: string; relativePath?: string; line?: number }
type ProductModule = { id: string; name: string; description?: string; functions: ModuleFunction[] }
type ModuleResponse = { storagePath: string; modules: ProductModule[] }
type ModuleDraft = { id?: string; name: string; description: string; functions: ModuleFunction[] }

type MappingDescriptor = {
  codeField: {
    targetKind?: string
    typeName?: string
    fieldName?: string
    qualifiedName?: string
    definitionPath?: string
    index?: number
  }
  instanceCount: number
  mappingSource?: string
  confidence?: string
  description?: string
  dictionaryFile?: string
  dictionaryRow?: number
  mappingFile?: string
  mappingFileRow?: number
}

type RunSummary = {
  runRecordId: string
  mappingCount: number
  sourceIds: string[]
  sources?: Array<{ sourceName?: string; name?: string; id?: string; rowCount?: number }>
}

type ReplaySummary = { returnedCount: number; totalRows: number; sampled?: boolean; times: Array<{ requestedTime: string }> }
type EvidenceContext = { run?: RunSummary; fields: MappingDescriptor[]; replay: ReplaySummary }
type Notice = { kind: 'error' | 'success'; message: string }
type ConnectedClient = { clientType?: string; clientName: string; connectedAt: string; lastSeenAt: string; workspaceRoot?: string }
type IntegrationStatus = {
  product: string
  version: string
  apiVersion: string
  runtimeMode: string
  vscodeWindows: ConnectedClient[]
  aiClients: ConnectedClient[]
  capabilities: string[]
}
type OpenCodeConfiguration = {
  serverName: string
  packageName: string
  artifactPattern: string
  current: Record<string, unknown>
  legacy: Record<string, unknown>
}

const DEMO_SOURCE = 'src/energy_dispatch_demo.cpp'
const demoNode = (label: string, signature: string, line: number): GraphNode => ({
  id: label,
  label,
  signature,
  filePath: DEMO_SOURCE,
  relativePath: DEMO_SOURCE,
  line,
  column: 1,
  kind: 'definition',
})
const demoEdge = (source: string, target: string, line: number): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  callSites: [{ line, column: 3 }],
})

const DEMO_MODULES: ProductModule[] = [
  {
    id: 'safety-governor', name: '安全约束', description: '检查温度与电压边界，并在异常时降额。', functions: [
      { functionName: 'check_thermal_limit', relativePath: DEMO_SOURCE },
      { functionName: 'check_voltage_limit', relativePath: DEMO_SOURCE },
      { functionName: 'apply_safety_derate', relativePath: DEMO_SOURCE },
      { functionName: 'raise_alarm', relativePath: DEMO_SOURCE },
    ],
  },
  {
    id: 'platform-services', name: '基础服务', description: '配置、时钟、审计和帧分配等公共能力。', functions: [
      { functionName: 'load_control_config', relativePath: DEMO_SOURCE },
      { functionName: 'monotonic_time_ms', relativePath: DEMO_SOURCE },
      { functionName: 'write_audit_log', relativePath: DEMO_SOURCE },
      { functionName: 'allocate_frame', relativePath: DEMO_SOURCE },
    ],
  },
  {
    id: 'event-delivery', name: '事件下发', description: '持久化控制指令并发布控制事件。', functions: [
      { functionName: 'enqueue_dispatch', relativePath: DEMO_SOURCE },
      { functionName: 'persist_command', relativePath: DEMO_SOURCE },
      { functionName: 'emit_control_event', relativePath: DEMO_SOURCE },
    ],
  },
  {
    id: 'data-acquisition', name: '数据采集', description: '读取、校验并发布母线测量数据。', functions: [
      { functionName: 'read_bus_snapshot', relativePath: DEMO_SOURCE },
      { functionName: 'validate_measurements', relativePath: DEMO_SOURCE },
      { functionName: 'normalize_samples', relativePath: DEMO_SOURCE },
      { functionName: 'publish_telemetry', relativePath: DEMO_SOURCE },
    ],
  },
  {
    id: 'energy-allocation', name: '能量分配', description: '估算需求、预测储能并计算各母线目标值。', functions: [
      { functionName: 'estimate_demand', relativePath: DEMO_SOURCE },
      { functionName: 'forecast_storage', relativePath: DEMO_SOURCE },
      { functionName: 'allocate_bus_targets', relativePath: DEMO_SOURCE },
      { functionName: 'clamp_dispatch', relativePath: DEMO_SOURCE },
    ],
  },
]

const DEMO_GRAPH: Graph = {
  analyzer: 'editor-language-service-demo',
  relativePath: DEMO_SOURCE,
  focusNodeId: 'run_dispatch_cycle',
  nodes: [
    demoNode('monotonic_time_ms', 'std::int64_t monotonic_time_ms()', 21),
    demoNode('allocate_frame', 'DispatchFrame allocate_frame()', 25),
    demoNode('load_control_config', 'ControlConfig load_control_config()', 29),
    demoNode('normalize_samples', 'double normalize_samples(double)', 33),
    demoNode('clamp_dispatch', 'double clamp_dispatch(double, double)', 37),
    demoNode('write_audit_log', 'void write_audit_log(const DispatchFrame&, std::int64_t)', 41),
    demoNode('raise_alarm', 'void raise_alarm(DispatchFrame&)', 44),
    demoNode('read_bus_snapshot', 'DispatchFrame read_bus_snapshot()', 49),
    demoNode('validate_measurements', 'bool validate_measurements(DispatchFrame&)', 55),
    demoNode('estimate_demand', 'double estimate_demand(const DispatchFrame&)', 64),
    demoNode('forecast_storage', 'double forecast_storage(const DispatchFrame&)', 70),
    demoNode('allocate_bus_targets', 'void allocate_bus_targets(DispatchFrame&, double, double)', 75),
    demoNode('check_thermal_limit', 'bool check_thermal_limit(DispatchFrame&)', 81),
    demoNode('check_voltage_limit', 'bool check_voltage_limit(DispatchFrame&)', 89),
    demoNode('apply_safety_derate', 'void apply_safety_derate(DispatchFrame&)', 97),
    demoNode('persist_command', 'void persist_command(const DispatchFrame&, std::int64_t)', 101),
    demoNode('emit_control_event', 'void emit_control_event(const DispatchFrame&, std::int64_t)', 104),
    demoNode('enqueue_dispatch', 'void enqueue_dispatch(const DispatchFrame&)', 107),
    demoNode('publish_telemetry', 'void publish_telemetry(const DispatchFrame&)', 111),
    demoNode('run_dispatch_cycle', 'int run_dispatch_cycle(std::int64_t)', 115),
    demoNode('demo_entry', 'int demo_entry()', 134),
  ],
  edges: [
    demoEdge('demo_entry', 'run_dispatch_cycle', 135),
    demoEdge('demo_entry', 'monotonic_time_ms', 135),
    demoEdge('raise_alarm', 'write_audit_log', 46),
    demoEdge('raise_alarm', 'monotonic_time_ms', 46),
    demoEdge('read_bus_snapshot', 'allocate_frame', 50),
    demoEdge('validate_measurements', 'normalize_samples', 56),
    demoEdge('validate_measurements', 'raise_alarm', 58),
    demoEdge('estimate_demand', 'normalize_samples', 67),
    demoEdge('forecast_storage', 'load_control_config', 71),
    demoEdge('allocate_bus_targets', 'clamp_dispatch', 76),
    demoEdge('check_thermal_limit', 'raise_alarm', 83),
    demoEdge('check_voltage_limit', 'raise_alarm', 91),
    demoEdge('apply_safety_derate', 'clamp_dispatch', 98),
    demoEdge('enqueue_dispatch', 'persist_command', 108),
    demoEdge('enqueue_dispatch', 'monotonic_time_ms', 108),
    demoEdge('publish_telemetry', 'emit_control_event', 112),
    demoEdge('publish_telemetry', 'monotonic_time_ms', 112),
    demoEdge('run_dispatch_cycle', 'load_control_config', 116),
    demoEdge('run_dispatch_cycle', 'read_bus_snapshot', 117),
    demoEdge('run_dispatch_cycle', 'validate_measurements', 118),
    demoEdge('run_dispatch_cycle', 'estimate_demand', 120),
    demoEdge('run_dispatch_cycle', 'forecast_storage', 121),
    demoEdge('run_dispatch_cycle', 'allocate_bus_targets', 122),
    demoEdge('run_dispatch_cycle', 'check_thermal_limit', 124),
    demoEdge('run_dispatch_cycle', 'check_voltage_limit', 125),
    demoEdge('run_dispatch_cycle', 'apply_safety_derate', 126),
    demoEdge('run_dispatch_cycle', 'enqueue_dispatch', 128),
    demoEdge('run_dispatch_cycle', 'publish_telemetry', 129),
    demoEdge('run_dispatch_cycle', 'write_audit_log', 130),
  ],
  limitations: ['这是界面演示数据；从编辑器打开后，会替换为当前编辑器语言服务返回的真实关系。'],
  semanticStatus: 'demo',
  statusSummary: '当前是演示界面',
  statusDetail: '这张图不是用户项目数据。请从编辑器的“历史诊断”面板打开 Web 工作台。',
}

function readContext(): WorkbenchContext {
  const params = new URLSearchParams(window.location.search)
  const documentVersion = params.get('documentVersion')
  return {
    workspaceRoot: params.get('workspaceRoot') ?? undefined,
    filePath: params.get('filePath') ?? undefined,
    dictionaryId: params.get('dictionaryId') ?? undefined,
    dictionaryName: params.get('dictionaryName') ?? undefined,
    runRecordId: params.get('runRecordId') ?? undefined,
    dataRevision: params.get('dataRevision') ?? undefined,
    requestedTime: params.get('requestedTime') ?? undefined,
    focusLine: params.get('focusLine') ?? undefined,
    focusColumn: params.get('focusColumn') ?? undefined,
    windowSessionId: params.get('windowSessionId') ?? undefined,
    documentVersion: documentVersion !== null && Number.isInteger(Number(documentVersion))
      ? Number(documentVersion)
      : undefined,
  }
}

const WORKBENCH_TOKEN_KEY = 'code-runtime-analyzer-access-token'

function workbenchAccessToken(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const received = fragment.get('access_token') ?? undefined
  if (received) {
    try { window.sessionStorage.setItem(WORKBENCH_TOKEN_KEY, received) } catch { /* private browsing may disable storage */ }
    fragment.delete('access_token')
    const remaining = fragment.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`)
    return received
  }
  try { return window.sessionStorage.getItem(WORKBENCH_TOKEN_KEY) ?? undefined } catch { return undefined }
}

const WORKBENCH_ACCESS_TOKEN = workbenchAccessToken()

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(WORKBENCH_ACCESS_TOKEN ? { 'x-code-runtime-analyzer-token': WORKBENCH_ACCESS_TOKEN } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(result.message ?? result.error ?? '请求失败')
  return result
}

async function requestGraph(
  context: WorkbenchContext,
  position?: Pick<GraphNode, 'filePath' | 'line' | 'column' | 'documentVersion'>,
  signal?: AbortSignal,
): Promise<Graph> {
  const filePath = position?.filePath ?? context.filePath
  const line = position?.line ?? (context.focusLine ? Number(context.focusLine) : 1)
  const column = position?.column ?? (context.focusColumn ? Number(context.focusColumn) : 1)
  const documentVersion = position?.documentVersion
    ?? (filePath === context.filePath ? context.documentVersion : undefined)

  if (!context.windowSessionId) {
    throw new Error('这个网页没有绑定编辑器窗口；本阶段不启动离线代码分析。')
  }
  const response = await postJson<EditorSemanticResponse>('/api/web/editor/semantic', {
    windowSessionId: context.windowSessionId,
    operation: 'callHierarchy',
    payload: {
      workspaceRoot: context.workspaceRoot,
      filePath,
      line,
      column,
      documentVersion,
    },
    timeoutMs: 25_000,
  }, signal)
  if (response.result && Array.isArray(response.result.nodes) && Array.isArray(response.result.edges)) {
    return response.result
  }
  return {
    nodes: [],
    edges: [],
    semanticStatus: 'noEvidence',
    statusSummary: '编辑器本次没有返回可展示结果',
    statusDetail: response.error ?? '编辑器连接器没有附带可验证的函数图；工具没有把空响应当作成功。',
    limitations: ['语义响应没有包含有效函数图。'],
  }
}

function mergeGraphs(current: Graph, incoming: Graph): Graph {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]))
  for (const node of incoming.nodes) nodes.set(node.id, { ...nodes.get(node.id), ...node })

  const edges = new Map(current.edges.map((edge) => [`${edge.source}\u0000${edge.target}`, edge]))
  for (const edge of incoming.edges) {
    const key = `${edge.source}\u0000${edge.target}`
    const existing = edges.get(key)
    if (!existing) {
      edges.set(key, edge)
      continue
    }
    const callSites = new Map(existing.callSites.map((site) => [`${site.line ?? ''}:${site.column ?? ''}`, site]))
    for (const site of edge.callSites) callSites.set(`${site.line ?? ''}:${site.column ?? ''}`, site)
    edges.set(key, { ...existing, ...edge, callSites: [...callSites.values()] })
  }

  return {
    ...current,
    ...incoming,
    focusNodeId: incoming.focusNodeId ?? current.focusNodeId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    limitations: [...new Set([...(current.limitations ?? []), ...(incoming.limitations ?? [])])],
    truncated: Boolean(current.truncated || incoming.truncated),
    omittedExternalCallCount: Math.max(current.omittedExternalCallCount ?? 0, incoming.omittedExternalCallCount ?? 0),
    oversizedFunctionCount: Math.max(current.oversizedFunctionCount ?? 0, incoming.oversizedFunctionCount ?? 0),
  }
}

function specificGraphLimitation(graph: Graph): string | undefined {
  return graph.limitations?.find((item) => ![
    '调用关系来自当前编辑器语言服务，只显示它明确返回的直接关系。',
    '当前结果来自编辑器正在使用的语言服务；编辑器没有明确返回的关系不会被猜测。',
  ].includes(item))
}

function graphStatusMessage(graph: Graph, subject?: string): string {
  const prefix = subject ? `${subject}：` : ''
  const detail = graph.statusDetail?.trim()
  const limitation = specificGraphLimitation(graph)
  if (graph.semanticStatus === 'demo') return detail ?? '当前是演示数据，不是用户项目的分析结果。'
  if (graph.semanticStatus === 'available') {
    const main = detail ?? `${prefix}当前编辑器已经返回可验证的一层调用关系。`
    return limitation ? `${main} ${limitation}` : main
  }
  if (graph.semanticStatus === 'noEvidence') {
    return detail ?? `${prefix}当前编辑器本次没有返回调用关系证据；这不表示代码里绝对不存在调用。`
  }
  return detail ?? graph.statusSummary ?? `${prefix}当前编辑器这次没有完成调用关系请求。`
}

function graphRequestKey(node: Pick<GraphNode, 'filePath' | 'line' | 'column' | 'documentVersion'>) {
  return `${node.filePath ?? ''}:${node.line ?? 1}:${node.column ?? 1}:${node.documentVersion ?? ''}`
}

async function requestEvidenceContext(context: WorkbenchContext, signal?: AbortSignal): Promise<EvidenceContext> {
  if (!context.runRecordId || !context.dataRevision) throw new Error('当前网页没有加载 CSV 回放上下文')
  const [runs, fields, replay] = await Promise.all([
    postJson<{ runs: RunSummary[] }>('/api/runs/list', {}, signal),
    postJson<{ fields: MappingDescriptor[] }>('/api/mappings/fields', {
      runRecordId: context.runRecordId,
      dataRevision: context.dataRevision,
    }, signal),
    postJson<ReplaySummary>('/api/replay/times', {
      runRecordId: context.runRecordId,
      dataRevision: context.dataRevision,
      limit: 80,
    }, signal),
  ])
  return {
    run: runs.runs.find((run) => run.runRecordId === context.runRecordId),
    fields: fields.fields,
    replay,
  }
}

function formatTime(value?: string) {
  if (!value) return '未选择回放时间'
  const numeric = Number(value)
  const date = Number.isFinite(numeric) ? new Date(Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric) : new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function degreeMap(graph: Graph) {
  const result = new Map<string, number>()
  for (const edge of graph.edges) {
    result.set(edge.source, (result.get(edge.source) ?? 0) + 1)
    result.set(edge.target, (result.get(edge.target) ?? 0) + 1)
  }
  return result
}

function focusedLayout(graph: Graph, selectedId: string, reduceMotion: boolean): { nodes: Node<FlowData>[]; edges: Edge[] } {
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes.find((node) => node.kind === 'definition')
  if (!selected) return { nodes: [], edges: [] }
  const callers = graph.edges.filter((edge) => edge.target === selected.id).map((edge) => edge.source)
  const callees = graph.edges.filter((edge) => edge.source === selected.id).map((edge) => edge.target)
  const callerIds = new Set(callers)
  const calleeIds = new Set(callees)
  const linked = graph.nodes.filter((node) => node.id !== selected.id && callerIds.has(node.id) && calleeIds.has(node.id))
  const left = graph.nodes.filter((node) => node.id !== selected.id && callerIds.has(node.id) && !calleeIds.has(node.id))
  const right = graph.nodes.filter((node) => node.id !== selected.id && calleeIds.has(node.id) && !callerIds.has(node.id))
  const positions = new Map<string, { x: number; y: number; role: FunctionRole }>()
  const centerX = 510
  const centerY = 320
  positions.set(selected.id, { x: centerX, y: centerY, role: 'current' })

  // Keep the canvas focused on the selected function's immediate neighborhood.
  // Showing every transitive node at once makes fitView zoom out and turns a
  // readable relationship map into a dense bundle of crossing lines.
  const placeSide = (nodes: GraphNode[], side: 'left' | 'right', role: FunctionRole) => {
    const columns = nodes.length > 7 ? 2 : 1
    const rows = Math.ceil(nodes.length / columns)
    const rowGap = 124
    const startY = centerY - ((rows - 1) * rowGap) / 2
    nodes.forEach((node, index) => {
      const column = Math.floor(index / rows)
      const row = index % rows
      const x = side === 'left' ? 15 - column * 270 : 865 + column * 270
      positions.set(node.id, { x, y: startY + row * rowGap, role })
    })
  }
  placeSide(left, 'left', 'caller')
  placeSide(right, 'right', 'callee')
  linked.forEach((node, index) => positions.set(node.id, { x: centerX + index * 260, y: centerY + 190, role: 'linked' }))
  const visibleIds = new Set([selected.id, ...left.map((node) => node.id), ...right.map((node) => node.id), ...linked.map((node) => node.id)])
  const degrees = degreeMap(graph)
  const nodes = graph.nodes.filter((node) => visibleIds.has(node.id)).map((node) => {
    const position = positions.get(node.id) ?? { x: centerX, y: centerY, role: 'external' as FunctionRole }
    return {
      id: node.id,
      type: 'function',
      position: { x: position.x, y: position.y },
      data: {
        ...node,
        selected: node.id === selected.id,
        degree: degrees.get(node.id) ?? 0,
        role: position.role,
        reduceMotion,
      },
    }
  })
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    && (edge.source === selected.id || edge.target === selected.id)).map((edge) => {
    const active = edge.source === selected.id || edge.target === selected.id
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      // Animated edges are rendered as marching dashes by React Flow.  They
      // make a dense call graph look broken, so relationship state is shown
      // with a solid line and a restrained color/weight difference instead.
      animated: false,
      className: active ? 'flow-edge flow-edge--active' : 'flow-edge',
      style: { stroke: active ? '#5d83ff' : '#58709c', strokeWidth: active ? 2.25 : 1.2 },
    }
  })
  return { nodes, edges }
}

function FunctionNode({ data }: NodeProps<Node<FlowData>>) {
  const external = data.kind !== 'definition'
  const roleLabel: Record<FunctionRole, string> = {
    current: '当前函数',
    caller: '直接调用方',
    callee: '直接被调用',
    linked: '关联函数',
    external: '外部声明',
  }
  return (
    <motion.div
      initial={false}
      animate={{ scale: data.selected ? 1.025 : 1, opacity: 1 }}
      transition={data.reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.34, bounce: 0.08 }}
      className={`function-node function-node--${data.role} ${data.selected ? 'is-selected' : ''} ${external ? 'is-external' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="function-node__eyebrow">
        {external ? <ArrowDownRight size={13} /> : <Braces size={13} />}
        <span>{roleLabel[data.role]}</span>
        {data.degree > 1 && <span className="function-node__degree">{data.degree}</span>}
      </div>
      <strong>{data.label}</strong>
      <code>{data.signature}</code>
      {data.relativePath && <small>{shortPath(data.relativePath)}{data.line ? `:${data.line}` : ''}</small>}
      <Handle type="source" position={Position.Right} />
    </motion.div>
  )
}

const nodeTypes = { function: FunctionNode }

function shortPath(value: string) {
  const pieces = value.split('/')
  return pieces.length > 2 ? `${pieces.slice(-2).join('/')}` : value
}

async function openInEditor(context: WorkbenchContext, node: GraphNode) {
  if (!node.filePath || !node.line) throw new Error('这个节点没有可确认的源文件位置')
  if (!context.windowSessionId) throw new Error('请从“历史诊断”面板打开 Web 工作台，才能定位回原窗口。')
  await postJson('/api/web/open-in-vscode', {
    filePath: node.filePath,
    line: node.line,
    column: node.column ?? 1,
    workspaceRoot: context.workspaceRoot,
    windowSessionId: context.windowSessionId,
  })
}

function fieldLabel(field: MappingDescriptor['codeField']) {
  if (field.qualifiedName) return `::${field.qualifiedName}`
  const owner = field.typeName ? `${field.typeName}::` : ''
  const index = field.index === undefined ? '' : `[${field.index}]`
  return `${owner}${field.fieldName ?? '未命名字段'}${index}`
}

function findGraphNode(reference: ModuleFunction, graph: Graph) {
  return graph.nodes.find((node) => node.kind === 'definition'
    && node.label === reference.functionName
    && (!reference.relativePath || node.relativePath === reference.relativePath))
}

function App() {
  const context = useMemo(readContext, [])
  const prefersReducedMotion = useReducedMotion()
  const hasEditorGraphContext = Boolean(context.filePath && context.windowSessionId)
  const [graph, setGraph] = useState<Graph>(context.filePath ? { nodes: [], edges: [] } : DEMO_GRAPH)
  const [graphLoading, setGraphLoading] = useState(hasEditorGraphContext)
  const [graphError, setGraphError] = useState<string | undefined>()
  const [graphMessage, setGraphMessage] = useState<string | undefined>(context.filePath && !context.windowSessionId
    ? '这个网页没有绑定编辑器窗口。本阶段不会自动启动离线分析；请从目标编辑器的“历史诊断”面板重新打开 Web 工作台。'
    : undefined)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('function')
  const [functionTab, setFunctionTab] = useState<FunctionTab>('calls')
  const [graphResetToken, setGraphResetToken] = useState(0)
  const [functionFilter, setFunctionFilter] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [selectedId, setSelectedId] = useState(DEMO_GRAPH.focusNodeId ?? DEMO_GRAPH.nodes[0]?.id ?? '')
  const [notice, setNotice] = useState<Notice | undefined>()
  const [modules, setModules] = useState<ProductModule[]>(context.workspaceRoot ? [] : DEMO_MODULES)
  const [modulesStoragePath, setModulesStoragePath] = useState('.cpp-csv-diagnostics/product-modules.json')
  const [modulesLoading, setModulesLoading] = useState(Boolean(context.workspaceRoot))
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>()
  const [moduleDraft, setModuleDraft] = useState<ModuleDraft | undefined>()
  const [moduleSaving, setModuleSaving] = useState(false)
  const [evidenceContext, setEvidenceContext] = useState<EvidenceContext | undefined>()
  const [evidenceLoading, setEvidenceLoading] = useState(Boolean(context.runRecordId && context.dataRevision))
  const [evidenceError, setEvidenceError] = useState<string | undefined>()
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | undefined>()
  const [openCodeConfiguration, setOpenCodeConfiguration] = useState<OpenCodeConfiguration | undefined>()
  const [integrationsLoading, setIntegrationsLoading] = useState(false)
  const functionSearchRef = useRef<HTMLInputElement>(null)
  const expandedNodeKeys = useRef(new Set<string>())
  const expandingNodeKeys = useRef(new Set<string>())

  useEffect(() => {
    const focusFunctionSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      functionSearchRef.current?.focus()
    }
    window.addEventListener('keydown', focusFunctionSearch)
    return () => window.removeEventListener('keydown', focusFunctionSearch)
  }, [])

  useEffect(() => {
    if (!context.filePath || !context.windowSessionId) return
    const controller = new AbortController()
    expandedNodeKeys.current.clear()
    expandingNodeKeys.current.clear()
    setGraphLoading(true)
    setGraphError(undefined)
    setGraphMessage('正在向当前编辑器请求这个函数的一层调用关系。')
    setGraph({ nodes: [], edges: [] })
    requestGraph(context, undefined, controller.signal)
      .then((next) => {
        setGraph(next)
        const focused = next.nodes.find((node) => node.id === next.focusNodeId) ?? next.nodes.find((node) => node.kind === 'definition')
        if (focused) {
          setSelectedId(focused.id)
          expandedNodeKeys.current.add(graphRequestKey(focused))
        }
        setGraphMessage(graphStatusMessage(next))
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        const detail = reason instanceof Error ? reason.message : String(reason)
        setGraphError(`当前编辑器这次没有返回可用的调用关系。它可能还在准备项目，或暂不支持调用层级。${detail ? ` 详细原因：${detail}` : ''}`)
      })
      .finally(() => !controller.signal.aborted && setGraphLoading(false))
    return () => controller.abort()
  }, [context])

  const loadModules = useCallback(async () => {
    if (!context.workspaceRoot) {
      setModules(DEMO_MODULES)
      setModulesLoading(false)
      return
    }
    setModulesLoading(true)
    try {
      const result = await postJson<ModuleResponse>('/api/product-modules/list', { workspaceRoot: context.workspaceRoot })
      setModules(result.modules)
      setModulesStoragePath(result.storagePath)
    } catch (reason) {
      setNotice({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setModulesLoading(false)
    }
  }, [context.workspaceRoot])

  useEffect(() => { void loadModules() }, [loadModules])

  const loadIntegrations = useCallback(async () => {
    setIntegrationsLoading(true)
    try {
      const [status, configuration] = await Promise.all([
        postJson<IntegrationStatus>('/api/integrations/status', {}),
        postJson<OpenCodeConfiguration>('/api/integrations/opencode-config', {}),
      ])
      setIntegrationStatus(status)
      setOpenCodeConfiguration(configuration)
    } catch (reason) {
      setNotice({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setIntegrationsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (workspaceView === 'integrations') void loadIntegrations()
  }, [loadIntegrations, workspaceView])

  useEffect(() => {
    if (!context.runRecordId || !context.dataRevision) return
    const controller = new AbortController()
    setEvidenceLoading(true)
    setEvidenceError(undefined)
    requestEvidenceContext(context, controller.signal)
      .then(setEvidenceContext)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setEvidenceError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => !controller.signal.aborted && setEvidenceLoading(false))
    return () => controller.abort()
  }, [context])

  useEffect(() => {
    if (selectedModuleId && modules.some((module) => module.id === selectedModuleId)) return
    setSelectedModuleId(modules[0]?.id)
  }, [modules, selectedModuleId])

  const definitions = useMemo(() => graph.nodes.filter((node) => node.kind === 'definition'), [graph.nodes])
  const filteredDefinitions = useMemo(() => {
    const query = functionFilter.trim().toLocaleLowerCase()
    if (!query) return definitions
    return definitions.filter((node) => `${node.label} ${node.signature} ${node.relativePath ?? ''}`.toLocaleLowerCase().includes(query))
  }, [definitions, functionFilter])
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? definitions[0]
  const calls = useMemo(() => graph.edges.filter((edge) => edge.source === selected?.id), [graph.edges, selected?.id])
  const callers = useMemo(() => graph.edges.filter((edge) => edge.target === selected?.id), [graph.edges, selected?.id])
  const flow = useMemo(() => focusedLayout(graph, selected?.id ?? '', Boolean(prefersReducedMotion)), [graph, prefersReducedMotion, selected?.id])
  const graphKey = useMemo(() => `${selected?.id ?? 'empty'}:${graph.nodes.map((node) => node.id).join('|')}`, [graph.nodes, selected?.id])
  const selectedModule = modules.find((module) => module.id === selectedModuleId)
  const currentModules = useMemo(() => selected ? modules.filter((module) => module.functions.some((reference) => Boolean(findGraphNode(reference, { ...graph, nodes: [selected] })))) : [], [graph, modules, selected])
  const hasCodeContext = Boolean(context.filePath)
  const isBoundToEditor = Boolean(context.windowSessionId)
  const canLocate = Boolean(selected?.filePath && isBoundToEditor)

  const selectFunction = useCallback((id: string) => {
    setSelectedId(id)
    setWorkspaceView('function')
    setFunctionTab('calls')
    setInspectorOpen(true)
  }, [])

  const selectAndExpandFunction = useCallback((id: string) => {
    selectFunction(id)
    if (!context.windowSessionId) return
    const node = graph.nodes.find((item) => item.id === id)
    if (!node?.filePath) return
    const requestKey = graphRequestKey(node)
    if (expandedNodeKeys.current.has(requestKey) || expandingNodeKeys.current.has(requestKey)) return

    expandingNodeKeys.current.add(requestKey)
    setGraphLoading(true)
    setGraphError(undefined)
    setGraphMessage(`正在向当前编辑器请求 ${node.label} 的一层调用关系。`)
    void requestGraph(context, node).then((next) => {
      expandedNodeKeys.current.add(requestKey)
      setGraph((current) => mergeGraphs(current, next))
      setGraphMessage(graphStatusMessage(next, node.label))
    }).catch((reason: unknown) => {
      const detail = reason instanceof Error ? reason.message : String(reason)
      setGraphError(`暂时无法展开 ${node.label}。编辑器可能还在准备项目，你可以稍后再点一次。${detail ? ` 详细原因：${detail}` : ''}`)
    }).finally(() => {
      expandingNodeKeys.current.delete(requestKey)
      setGraphLoading(expandingNodeKeys.current.size > 0)
    })
  }, [context, graph.nodes, selectFunction])

  const resetGraphView = useCallback(() => setGraphResetToken((value) => value + 1), [])

  const locateInCurrentEditor = useCallback((node: GraphNode) => {
    void openInEditor(context, node).then(() => {
      setNotice({ kind: 'success', message: `已把 ${node.label} 的位置发送回打开本页的编辑器窗口。` })
    }).catch((reason: unknown) => {
      setNotice({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    })
  }, [context])

  const openModuleEditor = useCallback((module?: ProductModule) => {
    if (!context.workspaceRoot) return
    setModuleDraft(module ? {
      id: module.id,
      name: module.name,
      description: module.description ?? '',
      functions: module.functions.map((item) => ({ ...item })),
    } : { name: '', description: '', functions: [] })
  }, [context.workspaceRoot])

  const addCurrentFunction = useCallback(() => {
    if (!selected || selected.kind !== 'definition') return
    const reference: ModuleFunction = {
      functionName: selected.label,
      ...(selected.relativePath ? { relativePath: selected.relativePath } : {}),
      ...(selected.line ? { line: selected.line } : {}),
    }
    setModuleDraft((draft) => {
      if (!draft) return draft
      if (draft.functions.some((item) => item.functionName === reference.functionName && item.relativePath === reference.relativePath)) {
        setNotice({ kind: 'error', message: '当前函数已经在这个模块里。' })
        return draft
      }
      return { ...draft, functions: [...draft.functions, reference] }
    })
  }, [selected])

  const saveModule = useCallback(async () => {
    if (!context.workspaceRoot || !moduleDraft) return
    if (!moduleDraft.name.trim()) {
      setNotice({ kind: 'error', message: '请先填写模块名称，再保存。' })
      return
    }
    setModuleSaving(true)
    try {
      const result = await postJson<ModuleResponse & { module: ProductModule }>('/api/product-modules/upsert', {
        workspaceRoot: context.workspaceRoot,
        module: moduleDraft,
      })
      setModules(result.modules)
      setModulesStoragePath(result.storagePath)
      setSelectedModuleId(result.module.id)
      setModuleDraft(undefined)
      setNotice({ kind: 'success', message: `已保存“${result.module.name}”。它现在是这个代码仓库中的用户定义功能模块。` })
    } catch (reason) {
      setNotice({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setModuleSaving(false)
    }
  }, [context.workspaceRoot, moduleDraft])

  const removeModule = useCallback((module: ProductModule) => {
    if (!context.workspaceRoot) return
    if (!window.confirm(`确定删除功能模块“${module.name}”吗？这只会删除模块定义，不会删除代码或字典。`)) return
    void postJson<ModuleResponse & { deleted: boolean }>('/api/product-modules/delete', {
      workspaceRoot: context.workspaceRoot,
      moduleId: module.id,
    }).then((result) => {
      setModules(result.modules)
      setModulesStoragePath(result.storagePath)
      setNotice({ kind: 'success', message: `已删除“${module.name}”的模块定义；代码和字典未受影响。` })
    }).catch((reason: unknown) => {
      setNotice({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    })
  }, [context.workspaceRoot])

  const switchToModule = useCallback((moduleId?: string) => {
    if (moduleId) setSelectedModuleId(moduleId)
    setWorkspaceView('modules')
  }, [])

  const copyConfiguration = useCallback((configuration: Record<string, unknown>, label: string) => {
    void navigator.clipboard.writeText(JSON.stringify(configuration, null, 2)).then(() => {
      setNotice({ kind: 'success', message: `已复制${label}配置，可以合并到 OpenCode 配置文件。` })
    }).catch((reason: unknown) => {
      setNotice({ kind: 'error', message: `复制失败：${reason instanceof Error ? reason.message : String(reason)}` })
    })
  }, [])

  return (
    <main className={`app-shell ${workspaceView === 'function' && inspectorOpen && selected ? 'is-inspector-open' : ''}`}>
      <header className="app-header">
        <div className="brand-lockup"><span className="brand-glyph"><Box size={18} /></span><span>代码结构工作台</span></div>
        <div className="header-actions">
          {workspaceView === 'integrations' ? <div className="header-context"><Cable size={16} /><span>独立后台与 AI 接入</span></div> : <label className="function-search"><Search size={16} /><input ref={functionSearchRef} value={functionFilter} onChange={(event) => setFunctionFilter(event.target.value)} placeholder="搜索函数（Ctrl+K）" aria-label="搜索当前文件函数" /></label>}
          {workspaceView === 'function' && functionTab === 'calls' ? (
            <button type="button" className="header-reset" onClick={resetGraphView}><RotateCcw size={15} />视图重置</button>
          ) : null}
          <div className="project-status"><span>项目状态：</span><strong>{isBoundToEditor && hasCodeContext ? '已连接' : isBoundToEditor ? '等待代码文件' : hasCodeContext ? '未绑定编辑器' : '演示模式'}</strong><i className={`connection-dot ${isBoundToEditor ? 'is-live' : ''}`} /></div>
        </div>
      </header>

      <aside className="side-rail">
        <nav className="primary-nav" aria-label="工作台导航">
          <button className={workspaceView === 'function' && functionTab !== 'time' && functionTab !== 'evidence' ? 'is-active' : ''} onClick={() => { setWorkspaceView('function'); setFunctionTab('calls') }}><Braces size={17} /><span>函数</span></button>
          <button className={workspaceView === 'modules' ? 'is-active' : ''} onClick={() => setWorkspaceView('modules')}><Layers3 size={17} /><span>产品功能模块</span></button>
          <button className={workspaceView === 'function' && (functionTab === 'time' || functionTab === 'evidence') ? 'is-active' : ''} onClick={() => { setWorkspaceView('function'); setFunctionTab('time') }}><Database size={17} /><span>历史数据</span></button>
          <button className={workspaceView === 'integrations' ? 'is-active' : ''} onClick={() => setWorkspaceView('integrations')}><Cable size={17} /><span>AI 与扩展</span></button>
        </nav>

        {workspaceView !== 'integrations' ? <section className="rail-section">
          <div className="rail-section__title"><span>函数列表</span><em>{filteredDefinitions.length}/{definitions.length}</em></div>
          <label className="rail-search"><Search size={15} /><input value={functionFilter} onChange={(event) => setFunctionFilter(event.target.value)} placeholder="筛选函数" aria-label="筛选当前文件函数" /></label>
          <div className="function-list">
            {filteredDefinitions.length > 0 ? filteredDefinitions.map((node) => (
              <button key={node.id} className={node.id === selected?.id ? 'is-selected' : ''} onClick={() => selectAndExpandFunction(node.id)}>
                <Braces size={14} /><span><strong>{node.label}</strong><small>{node.line ? `第 ${node.line} 行` : '函数定义'}</small></span>
              </button>
            )) : <p className="rail-empty">没有匹配的函数。</p>}
          </div>
        </section> : <section className="rail-section integration-rail"><div className="rail-section__title"><span>后台核心能力</span></div>{integrationStatus?.capabilities.map((capability) => <div key={capability} className="integration-rail__item"><CheckCircle2 size={14} /><span>{capability}</span></div>)}</section>}

        <section className="rail-footnote">
          <div><CircleDot size={14} /><span>{isBoundToEditor ? '已绑定打开本页的编辑器窗口' : hasCodeContext ? '已读取代码位置，但没有绑定编辑器窗口' : '未绑定编辑器：当前是示例界面'}</span></div>
          <p>调用关系只展示当前编辑器语言服务本次返回的结果；不会把回放时间误当成运行路径。</p>
        </section>
      </aside>

      <section className="workspace">
        {workspaceView === 'function' ? (
          <FunctionWorkspace
            tab={functionTab}
            onTabChange={setFunctionTab}
            graph={graph}
            graphLoading={graphLoading}
            graphError={graphError}
            graphMessage={graphMessage}
            selected={selected}
            flow={flow}
            graphKey={graphKey}
            graphResetToken={graphResetToken}
            calls={calls}
            callers={callers}
            context={context}
            canLocate={canLocate}
            onNodeSelect={selectAndExpandFunction}
            onLocate={locateInCurrentEditor}
            evidenceContext={evidenceContext}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            currentModules={currentModules}
            onShowModule={switchToModule}
            canCreateModule={Boolean(context.workspaceRoot)}
            onCreateModule={() => { setWorkspaceView('modules'); openModuleEditor() }}
            onResetGraph={resetGraphView}
          />
        ) : workspaceView === 'modules' ? (
          <ModulesWorkspace
            modules={modules}
            selectedModule={selectedModule}
            selectedModuleId={selectedModuleId}
            graph={graph}
            loading={modulesLoading}
            storagePath={modulesStoragePath}
            canEdit={Boolean(context.workspaceRoot)}
            onSelect={setSelectedModuleId}
            onCreate={() => openModuleEditor()}
            onEdit={openModuleEditor}
            onDelete={removeModule}
            onRefresh={() => void loadModules()}
            onSelectFunction={selectAndExpandFunction}
          />
        ) : <IntegrationsWorkspace status={integrationStatus} configuration={openCodeConfiguration} loading={integrationsLoading} onRefresh={() => void loadIntegrations()} onCopy={copyConfiguration} />}
      </section>

      <AnimatePresence initial={false}>
        {workspaceView === 'function' && inspectorOpen && selected && (
          <motion.aside
            className="inspector"
            initial={prefersReducedMotion ? false : { opacity: 0, x: 22 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, x: 22 }}
            transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', duration: 0.32, bounce: 0.08 }}
          >
            <div className="inspector__top"><div><p>当前函数</p><h2>{selected.label}</h2></div><button aria-label="关闭函数详情" onClick={() => setInspectorOpen(false)}><X size={17} /></button></div>
            <div className="signature"><Code2 size={15} /><code>{selected.signature}</code></div>
            <div className="location"><FileCode2 size={15} /><span>{selected.relativePath ?? '外部声明'}{selected.line ? ` : ${selected.line}` : ''}</span></div>
            <div className="inspector-metric-grid" aria-label="当前函数关系统计">
              <InspectorMetric label="本次返回：直接调用" value={calls.length} />
              <InspectorMetric label="本次返回：调用它" value={callers.length} />
              <InspectorMetric label="当前关系图" value={flow.nodes.length} suffix="个函数" />
            </div>
            {selected.kind === 'definition' && canLocate ? (
              <button className="primary-button locate-button" onClick={() => locateInCurrentEditor(selected)}><ExternalLink size={16} />在编辑器中定位</button>
            ) : selected.kind === 'definition' ? (
              <div className="quiet-notice">此页面不是从“历史诊断”面板打开，无法安全定位回原窗口。</div>
            ) : <div className="quiet-notice">当前编辑器没有返回这个声明的实现位置；工具不会猜测。</div>}
            <InspectorSection title="它直接调用" count={calls.length} icon={<ArrowDownRight size={15} />}>
              {calls.length ? calls.map((edge) => <ConnectionRow key={edge.id} edge={edge} graph={graph} direction="out" onSelect={selectAndExpandFunction} />) : <EmptyState text="当前编辑器语言服务本次没有返回直接被调用函数" />}
            </InspectorSection>
            <InspectorSection title="直接调用它" count={callers.length} icon={<ArrowUpRight size={15} />}>
              {callers.length ? callers.map((edge) => <ConnectionRow key={edge.id} edge={edge} graph={graph} direction="in" onSelect={selectAndExpandFunction} />) : <EmptyState text="当前编辑器语言服务本次没有返回直接调用方" />}
            </InspectorSection>
            <InspectorSection title="所属产品模块" count={currentModules.length} icon={<Layers3 size={15} />}>
              {currentModules.length ? currentModules.map((module) => <button className="module-inspector-row" key={module.id} onClick={() => switchToModule(module.id)}><span>{module.name}</span><ChevronRight size={14} /></button>) : <EmptyState text="尚未归入用户定义的产品模块" />}
            </InspectorSection>
            <section className="inspector-history-status">
              <p>最近一次历史数据状态</p>
              {context.runRecordId ? <dl><div><dt>数据时间点</dt><dd>{formatTime(context.requestedTime)}</dd></div><div><dt>已加载字段</dt><dd>{evidenceContext?.fields.length ?? 0} 条</dd></div><div><dt>CSV 回放</dt><dd>{evidenceLoading ? '正在读取' : evidenceError ? '读取失败' : '已加载'}</dd></div></dl> : <span>尚未加载 CSV 回放；不会显示虚构的执行次数或耗时。</span>}
            </section>
            <div className="fact-note"><ShieldCheck size={16} /><span>调用关系来自当前编辑器语言服务。空结果只代表本次没有返回，不表示项目里绝对不存在调用。</span></div>
          </motion.aside>
        )}
      </AnimatePresence>

      {workspaceView === 'function' && !inspectorOpen && selected && <button className="inspector-reopen" onClick={() => setInspectorOpen(true)}><PanelRightOpen size={18} />打开函数详情</button>}

      <AnimatePresence>
        {moduleDraft && (
          <ModuleEditor
            draft={moduleDraft}
            selected={selected}
            saving={moduleSaving}
            onChange={setModuleDraft}
            onAddCurrent={addCurrentFunction}
            onSave={() => void saveModule()}
            onClose={() => setModuleDraft(undefined)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && <motion.div className={`notice-toast notice-toast--${notice.kind}`} initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={prefersReducedMotion ? undefined : { opacity: 0, y: 10 }}><div><strong>{notice.kind === 'error' ? '网页工作台提示' : '操作完成'}</strong><span>{notice.message}</span></div><button aria-label="关闭提示" onClick={() => setNotice(undefined)}><X size={15} /></button></motion.div>}
      </AnimatePresence>
      <footer className="app-footer"><span>当前显示：{workspaceView === 'function' ? functionTab === 'calls' ? '二维关系图' : functionTab === 'time' ? '历史数据' : functionTab === 'evidence' ? '证据来源' : '函数概览' : workspaceView === 'modules' ? '产品功能模块' : 'AI 与扩展'}</span><span>{workspaceView === 'integrations' ? `编辑器 ${integrationStatus?.vscodeWindows.length ?? 0} ／ AI ${integrationStatus?.aiClients.length ?? 0}` : `当前关系节点 ${flow.nodes.length} ／ 调用边 ${flow.edges.length}`}</span><span>数据时间点：{context.runRecordId ? formatTime(context.requestedTime) : '未加载 CSV'}</span></footer>
    </main>
  )
}

function IntegrationsWorkspace({ status, configuration, loading, onRefresh, onCopy }: {
  status?: IntegrationStatus
  configuration?: OpenCodeConfiguration
  loading: boolean
  onRefresh: () => void
  onCopy: (configuration: Record<string, unknown>, label: string) => void
}) {
  return <div className="integrations-workspace">
    <section className="integrations-hero">
      <div><span className="identity-chip"><Cable size={14} />平台核心</span><h2>一个后台，连接所有入口</h2><p>编辑器、网页和 OpenCode / AI 共用字典、CSV、代码分析和缓存，不会各自保存一套互相打架的数据。</p></div>
      <button className="secondary-button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />{loading ? '正在检查' : '刷新连接状态'}</button>
    </section>
    <section className="integration-metrics">
      <article><span>后台版本</span><strong>{status?.version ?? '正在读取'}</strong><small>API {status?.apiVersion ?? '—'} · {status?.runtimeMode === 'standalone' ? '独立后台' : '扩展备用后台'}</small></article>
      <article><span>编辑器窗口</span><strong>{status?.vscodeWindows.length ?? 0}</strong><small>每个网页只回到发起它的窗口</small></article>
      <article><span>OpenCode / AI</span><strong>{status?.aiClients.length ?? 0}</strong><small>{status?.aiClients.length ? '当前有 MCP 客户端在线' : '等待 OpenCode 启动 MCP'}</small></article>
    </section>
    <section className="integration-grid">
      <article className="integration-card">
        <div className="integration-card__head"><div><Cable size={18} /><span><strong>编辑器连接插件</strong><small>代码行内展示与窗口定位</small></span></div><em className={status?.vscodeWindows.length ? 'is-online' : ''}>{status?.vscodeWindows.length ? '已连接' : '未连接'}</em></div>
        <div className="client-list">{status?.vscodeWindows.length ? status.vscodeWindows.map((client, index) => <div key={`${client.connectedAt}-${index}`}><CheckCircle2 size={14} /><span><strong>{client.clientName}</strong><small>{client.workspaceRoot ?? '未报告工作区'}</small></span></div>) : <p>打开目标编辑器并启用连接插件后会在这里出现。</p>}</div>
      </article>
      <article className="integration-card">
        <div className="integration-card__head"><div><Activity size={18} /><span><strong>OpenCode + AI 模型</strong><small>通过 MCP 使用同一个后台</small></span></div><em className={status?.aiClients.length ? 'is-online' : ''}>{status?.aiClients.length ? '已连接' : '可配置'}</em></div>
        <div className="client-list">{status?.aiClients.length ? status.aiClients.map((client, index) => <div key={`${client.connectedAt}-${index}`}><CheckCircle2 size={14} /><span><strong>{client.clientName}</strong><small>最近心跳 {new Date(client.lastSeenAt).toLocaleTimeString('zh-CN', { hour12: false })}</small></span></div>) : <p>配置后，AI 可以查询历史快照、趋势、字段映射和函数调用关系。</p>}</div>
      </article>
    </section>
    <section className="opencode-config-card">
      <div><p>OpenCode 接入</p><h3>MCP 需要用户单独安装</h3><span>先从 GitHub Release 下载 MCP 包并在 OpenCode 所在环境中安装，再复制配置。EXE 不会修改 OpenCode 或 WSL。</span></div>
      <code>{configuration ? `${configuration.artifactPattern} → ${configuration.packageName}` : '正在读取 MCP 安装说明…'}</code>
      <div className="opencode-actions">
        <button className="primary-button" disabled={!configuration} onClick={() => configuration && onCopy(configuration.current, '新版 OpenCode')}><Copy size={15} />复制新版配置</button>
        <button className="secondary-button" disabled={!configuration} onClick={() => configuration && onCopy(configuration.legacy, 'OpenCode 1.x')}><Copy size={15} />复制 1.x 配置</button>
      </div>
      <div className="integration-safety"><ShieldCheck size={16} /><span>后台仅监听本机 127.0.0.1；MCP 只做适配，数据解析和匹配规则始终由后台统一执行。</span></div>
    </section>
  </div>
}

function InspectorMetric({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return <div><span>{label}</span><strong>{value}{suffix ? <small>{suffix}</small> : null}</strong></div>
}

function FunctionWorkspace({
  tab,
  onTabChange,
  graph,
  graphLoading,
  graphError,
  graphMessage,
  selected,
  flow,
  graphKey,
  graphResetToken,
  calls,
  callers,
  context,
  canLocate,
  onNodeSelect,
  onLocate,
  evidenceContext,
  evidenceLoading,
  evidenceError,
  currentModules,
  onShowModule,
  canCreateModule,
  onCreateModule,
  onResetGraph,
}: {
  tab: FunctionTab
  onTabChange: (tab: FunctionTab) => void
  graph: Graph
  graphLoading: boolean
  graphError?: string
  graphMessage?: string
  selected?: GraphNode
  flow: { nodes: Node<FlowData>[]; edges: Edge[] }
  graphKey: string
  graphResetToken: number
  calls: GraphEdge[]
  callers: GraphEdge[]
  context: WorkbenchContext
  canLocate: boolean
  onNodeSelect: (id: string) => void
  onLocate: (node: GraphNode) => void
  evidenceContext?: EvidenceContext
  evidenceLoading: boolean
  evidenceError?: string
  currentModules: ProductModule[]
  onShowModule: (id?: string) => void
  canCreateModule: boolean
  onCreateModule: () => void
  onResetGraph: () => void
}) {
  const tabs: Array<{ id: FunctionTab; label: string; icon: ReactNode }> = [
    { id: 'overview', label: '概览', icon: <Info size={15} /> },
    { id: 'calls', label: '调用关系', icon: <GitBranch size={15} /> },
    { id: 'time', label: '字段与时间', icon: <Activity size={15} /> },
    { id: 'evidence', label: '证据来源', icon: <MapPinned size={15} /> },
  ]
  return (
    <div className={`function-workspace function-workspace--${tab}`}>
      <div className="function-identity">
        <div><span className="identity-chip"><Braces size={14} />函数</span><h2>{selected?.label ?? '还没有可展示的函数'}</h2><code>{selected?.signature ?? '请从编辑器打开一个已保存的 C/C++ 文件。'}</code></div>
        <div className="identity-actions">
          {selected?.kind === 'definition' && canLocate && <button className="primary-button" onClick={() => onLocate(selected)}><ExternalLink size={16} />在编辑器中定位</button>}
          {graphLoading && <span className="loading-state"><LoaderCircle size={15} />正在询问当前编辑器</span>}
        </div>
      </div>
      <div className="tab-row" role="tablist" aria-label="函数工作台页面">
        {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => onTabChange(item.id)}>{item.icon}{item.label}</button>)}
      </div>

      {tab === 'overview' && <FunctionOverview selected={selected} calls={calls} callers={callers} graph={graph} currentModules={currentModules} onShowModule={onShowModule} canCreateModule={canCreateModule} onCreateModule={onCreateModule} />}
      {tab === 'calls' && <CallGraphPanel graph={graph} loading={graphLoading} error={graphError} message={graphMessage} flow={flow} graphKey={graphKey} resetToken={graphResetToken} onNodeSelect={onNodeSelect} onReset={onResetGraph} />}
      {tab === 'time' && <TimeAndFieldsPanel context={context} evidence={evidenceContext} loading={evidenceLoading} error={evidenceError} />}
      {tab === 'evidence' && <EvidenceSourcePanel context={context} evidence={evidenceContext} loading={evidenceLoading} error={evidenceError} />}
    </div>
  )
}

function FunctionOverview({ selected, calls, callers, graph, currentModules, onShowModule, canCreateModule, onCreateModule }: {
  selected?: GraphNode
  calls: GraphEdge[]
  callers: GraphEdge[]
  graph: Graph
  currentModules: ProductModule[]
  onShowModule: (id?: string) => void
  canCreateModule: boolean
  onCreateModule: () => void
}) {
  if (!selected) return <EmptyWorkspace title="没有可展示的函数" detail="请从编辑器的“历史诊断”面板打开 Web 工作台，系统会根据当前文件位置向编辑器语言服务请求局部调用关系。" />
  return (
    <section className="overview-grid">
      <article className="overview-card overview-card--identity">
        <div className="card-eyebrow"><Code2 size={15} />当前诊断对象</div>
        <h3>{selected.label}</h3>
        <code>{selected.signature}</code>
        <p><FileCode2 size={14} />{selected.relativePath ?? '当前编译单元外的声明'}{selected.line ? ` · 第 ${selected.line} 行` : ''}</p>
      </article>
      <article className="overview-card overview-card--metric"><span>直接调用它</span><strong>{callers.length}</strong><small>当前编辑器本次返回</small></article>
      <article className="overview-card overview-card--metric"><span>它直接调用</span><strong>{calls.length}</strong><small>不把虚调用、回调当作确定关系</small></article>
      <article className="overview-card overview-card--metric"><span>本次局部图</span><strong>{graph.nodes.filter((node) => node.kind === 'definition').length}</strong><small>{graph.truncated ? '结果为保护性能已截断' : '函数节点'}</small></article>
      <article className="overview-card overview-card--wide">
        <div className="card-eyebrow"><Cable size={15} />这页在说明什么</div>
        <p>以 <strong>{selected.label}</strong> 为中心，先看它的静态代码关系，再看同一次 CSV 回放的字段事实。图上的箭头只表示代码里能确认的直接调用，<b>不表示这次回放一定走过这条路径</b>。</p>
        {graph.limitations?.map((item) => <span key={item} className="fact-chip"><CheckCircle2 size={13} />{item}</span>)}
      </article>
      <article className="overview-card overview-card--modules">
        <div className="card-eyebrow"><Layers3 size={15} />所属产品能力</div>
        {currentModules.length > 0 ? <div className="module-link-list">{currentModules.map((module) => <button key={module.id} onClick={() => onShowModule(module.id)}><span>{module.name}</span><ChevronRight size={15} /></button>)}</div> : <div className="no-module-state"><p>这个函数尚未归入任何用户定义的产品功能模块。</p>{canCreateModule && <button className="secondary-button" onClick={onCreateModule}><Plus size={15} />定义产品功能模块</button>}</div>}
      </article>
    </section>
  )
}

function CallGraphPanel({
  graph,
  loading,
  error,
  message,
  flow,
  graphKey,
  resetToken,
  onNodeSelect,
  onReset,
}: {
  graph: Graph
  loading: boolean
  error?: string
  message?: string
  flow: { nodes: Node<FlowData>[]; edges: Edge[] }
  graphKey: string
  resetToken: number
  onNodeSelect: (id: string) => void
  onReset: () => void
}) {
  if (!loading && graph.nodes.length === 0) return <EmptyWorkspace title="调用关系暂时不可用" detail={error ?? message ?? '当前编辑器语言服务这次没有返回可展示的函数。这不表示项目里一定没有调用关系。'} />
  const limitation = specificGraphLimitation(graph)
  const partial = Boolean(graph.truncated || limitation || (graph.semanticStatus && !['available', 'demo'].includes(graph.semanticStatus)))
  const statusText = error ?? message ?? graphStatusMessage(graph)
  return (
    <section className="call-graph-panel" aria-label="当前函数的调用关系图">
      <div className="call-graph-toolbar">
        <div><span className="graph-chip"><Cable size={14} />调用层次关系</span><p>当前图来自编辑器语言服务；点击函数节点会按需请求并加入下一层。</p></div><div className="graph-toolbar__right"><div className="graph-legend"><span><i className="legend-current" />当前函数</span><span><i className="legend-caller" />调用方</span><span><i className="legend-callee" />被调用函数</span></div><button type="button" className="graph-reset" onClick={onReset}><RotateCcw size={14} />重置视图</button></div>
      </div>
      {(error || message || partial || graph.semanticStatus === 'demo') && <div className={`graph-availability ${error ? 'is-error' : partial ? 'is-partial' : ''}`}><Info size={14} /><span>{statusText}</span></div>}
      <div className="graph-stage">
        <div className="two-d-graph"><ReactFlow
            key={`${graphKey}:${resetToken}`}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onNodeSelect(node.id)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.28}
            maxZoom={1.55}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={25} size={1} color="#d9e4dc" />
            <MiniMap nodeColor={(node) => node.data?.role === 'current' ? '#2b765c' : node.data?.role === 'caller' ? '#c18445' : '#5d9a74'} maskColor="rgba(244, 249, 245, .78)" bgColor="#ffffff" />
            <Controls showInteractive={false} />
          </ReactFlow></div>
        {loading && <div className="graph-loading"><LoaderCircle className="spin" size={17} />正在向当前编辑器请求这一层调用关系…</div>}
      </div>
      <div className="graph-footnote"><span><Info size={14} />定位只会回到打开本页的编辑器窗口；空结果只代表语言服务本次没有返回。</span><span>{graph.nodes.filter((node) => node.kind === 'definition').length} 个函数节点 · {graph.edges.length} 条已返回调用边</span>{graph.oversizedFunctionCount ? <span>{graph.oversizedFunctionCount} 个复杂函数为保护性能已停止继续展开</span> : graph.omittedExternalCallCount ? <span>另有 {graph.omittedExternalCallCount} 个外部调用未展开</span> : <span>当前只展示已请求的局部关系</span>}</div>
    </section>
  )
}

function TimeAndFieldsPanel({ context, evidence, loading, error }: { context: WorkbenchContext; evidence?: EvidenceContext; loading: boolean; error?: string }) {
  if (!context.runRecordId) return <EmptyWorkspace title="还没有 CSV 回放上下文" detail="请在编辑器的“历史诊断”面板选择字典、CSV 文件夹和回放时间。网页只读取这次已选择的上下文，不在这里重复配置。" />
  if (loading) return <LoadingWorkspace label="正在读取当前 CSV 回放上下文" />
  if (error) return <EmptyWorkspace title="无法读取当前回放数据" detail={error} />
  const sources = evidence?.run?.sources ?? []
  return (
    <section className="data-workspace">
      <div className="data-summary-grid">
        <DataMetric label="当前回放时刻" value={formatTime(context.requestedTime)} icon={<CircleDot size={16} />} />
        <DataMetric label="可用时间点" value={`${evidence?.replay.returnedCount ?? 0} 个`} sub={evidence?.replay.sampled ? '为保持性能已均匀抽样展示' : undefined} icon={<Activity size={16} />} />
        <DataMetric label="加载字段规则" value={`${evidence?.fields.length ?? 0} 条`} sub="来自当前已选字典" icon={<MapPinned size={16} />} />
        <DataMetric label="CSV 数据行" value={`${evidence?.replay.totalRows ?? 0}`} sub={sources.length ? `${sources.length} 个数据源` : '数据源未返回摘要'} icon={<Database size={16} />} />
      </div>
      <article className="explanation-card"><Info size={18} /><div><strong>这页的范围</strong><p>展示的是当前编辑器“历史诊断”面板加载的字典和 CSV 回放上下文。它不声称每个字段都出现在上方函数里；某个字段是否出现在当前代码行，由编辑器中的行内历史值和悬停证据确认。</p></div></article>
      <section className="field-table-card">
        <div className="section-heading"><div><p>字典已加载字段</p><h3>可用于回放的代码字段</h3></div><span>{evidence?.fields.length ?? 0} 条</span></div>
        {evidence?.fields.length ? <div className="field-list">{evidence.fields.slice(0, 40).map((field) => <div className="field-row" key={`${fieldLabel(field.codeField)}:${field.instanceCount}`}><code>{fieldLabel(field.codeField)}</code><span>{field.instanceCount > 1 ? `${field.instanceCount} 个实例` : '单个值'}</span><small>{field.codeField.definitionPath ?? '定义文件未返回'}</small></div>)}</div> : <EmptyState text="当前字典没有返回字段规则" />}
        {(evidence?.fields.length ?? 0) > 40 && <p className="table-note">为保持页面可读性，此处显示前 40 条；完整字段仍由编辑器中的代码位置按需匹配。</p>}
      </section>
    </section>
  )
}

function EvidenceSourcePanel({ context, evidence, loading, error }: { context: WorkbenchContext; evidence?: EvidenceContext; loading: boolean; error?: string }) {
  if (!context.runRecordId) return <EmptyWorkspace title="没有可追溯的证据来源" detail="加载字典和 CSV 后，这里会显示每条字段规则来自哪个字典行，以及它指向的定义文件。" />
  if (loading) return <LoadingWorkspace label="正在读取字段规则的来源" />
  if (error) return <EmptyWorkspace title="无法读取字段规则来源" detail={error} />
  return (
    <section className="evidence-workspace">
      <article className="evidence-principle"><ShieldCheck size={20} /><div><h3>证据分层，不猜测</h3><p>字典说明“CSV 某列对应什么代码对象”；CSV 说明“某个时间点的值”；当前编辑器语言服务说明“这次识别到了哪些函数和字段”。页面会把三件事分开显示。</p></div></article>
      <section className="evidence-list-card">
        <div className="section-heading"><div><p>字段字典规则</p><h3>每一条规则都可追溯</h3></div><span>{evidence?.fields.length ?? 0} 条</span></div>
        {evidence?.fields.length ? <div className="evidence-list">{evidence.fields.map((field) => <article key={`${fieldLabel(field.codeField)}:${field.instanceCount}`}><div><code>{fieldLabel(field.codeField)}</code><span className="confidence-chip">{field.confidence === 'confirmed' ? '已确认' : field.confidence ?? '字典规则'}</span></div><dl><div><dt>字典位置</dt><dd>{field.dictionaryFile ?? field.mappingFile ?? context.dictionaryName ?? context.dictionaryId ?? '当前选择的字典'}{field.dictionaryRow ?? field.mappingFileRow ? ` 第 ${field.dictionaryRow ?? field.mappingFileRow} 行` : ''}</dd></div><div><dt>定义位置</dt><dd>{field.codeField.definitionPath ?? '未返回定义文件'}</dd></div><div><dt>CSV 实例</dt><dd>{field.instanceCount} 个</dd></div></dl></article>)}</div> : <EmptyState text="当前字典没有返回可追溯的字段规则" />}
      </section>
    </section>
  )
}

function ModulesWorkspace({ modules, selectedModule, selectedModuleId, graph, loading, storagePath, canEdit, onSelect, onCreate, onEdit, onDelete, onRefresh, onSelectFunction }: {
  modules: ProductModule[]
  selectedModule?: ProductModule
  selectedModuleId?: string
  graph: Graph
  loading: boolean
  storagePath: string
  canEdit: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (module: ProductModule) => void
  onDelete: (module: ProductModule) => void
  onRefresh: () => void
  onSelectFunction: (id: string) => void
}) {
  return (
    <div className="modules-workspace">
      <section className="modules-hero">
        <div><span className="identity-chip"><Layers3 size={14} />用户定义</span><h2>用产品能力组织函数，不用目录冒充模块</h2><p>一个模块是产品的一项真实能力，例如“母线目标值分配”；它可以关联多个跨目录函数，同一个函数也可以属于多个模块。</p></div>
        <div className="modules-hero__actions">{canEdit && <button className="secondary-button" onClick={onRefresh}><RefreshCw size={15} />重新读取</button>}{canEdit && <button className="primary-button" onClick={onCreate}><Plus size={16} />新建功能模块</button>}</div>
      </section>
      {!canEdit && <div className="workspace-warning"><Info size={16} />请从编辑器打开这页，系统才能把模块保存到当前代码仓库。</div>}
      <div className="modules-layout">
        <section className="module-list-card">
          <div className="section-heading"><div><p>当前产品的模块</p><h3>{loading ? '正在读取…' : `${modules.length} 个功能模块`}</h3></div></div>
          {loading ? <LoadingWorkspace label="正在读取模块配置" compact /> : modules.length ? <div className="module-list">{modules.map((module) => <button key={module.id} className={module.id === selectedModuleId ? 'is-selected' : ''} onClick={() => onSelect(module.id)}><span className="module-list__icon"><Layers3 size={16} /></span><span><strong>{module.name}</strong><small>{module.functions.length} 个关联函数</small></span><ChevronRight size={15} /></button>)}</div> : <div className="module-empty"><Layers3 size={22} /><strong>还没有定义功能模块</strong><p>先按产品能力命名，再把相关函数加入进来；它不会改变代码、字典或 CSV。</p>{canEdit && <button className="primary-button" onClick={onCreate}><Plus size={15} />定义第一个模块</button>}</div>}
        </section>
        <section className="module-detail-card">
          {selectedModule ? <ModuleDetail module={selectedModule} graph={graph} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} onSelectFunction={onSelectFunction} /> : <div className="module-detail-empty"><FolderMessage /><h3>选择一个功能模块</h3><p>模块的边界由用户按产品能力定义，不从源代码目录自动推断。</p></div>}
        </section>
      </div>
      <p className="module-storage-note">模块定义保存在当前代码仓库的 <code>{storagePath}</code>。它使用仓库相对路径，因此同一产品在不同电脑上不需要改路径。</p>
    </div>
  )
}

function FolderMessage() { return <Layers3 size={32} /> }

function ModuleDetail({ module, graph, canEdit, onEdit, onDelete, onSelectFunction }: { module: ProductModule; graph: Graph; canEdit: boolean; onEdit: (module: ProductModule) => void; onDelete: (module: ProductModule) => void; onSelectFunction: (id: string) => void }) {
  return <div className="module-detail"><div className="module-detail__head"><div><span className="identity-chip"><Layers3 size={14} />产品能力</span><h2>{module.name}</h2><p>{module.description || '暂未填写能力说明。'}</p></div>{canEdit && <div className="module-detail__actions"><button className="secondary-icon-button" aria-label="编辑模块" onClick={() => onEdit(module)}><Code2 size={16} /></button><button className="danger-icon-button" aria-label="删除模块" onClick={() => onDelete(module)}><Trash2 size={16} /></button></div>}</div><section className="module-functions"><div className="section-heading"><div><p>关联函数</p><h3>{module.functions.length} 个</h3></div></div>{module.functions.length ? module.functions.map((reference) => { const node = findGraphNode(reference, graph); return node ? <button className="module-function-row" key={`${reference.functionName}:${reference.relativePath ?? ''}`} onClick={() => onSelectFunction(node.id)}><Braces size={15} /><span><strong>{reference.functionName}</strong><small>{reference.relativePath ?? '未填写相对路径'}{reference.line ? ` · 第 ${reference.line} 行` : ''}</small></span><ChevronRight size={15} /></button> : <div className="module-function-row is-unavailable" key={`${reference.functionName}:${reference.relativePath ?? ''}`}><Braces size={15} /><span><strong>{reference.functionName}</strong><small>{reference.relativePath ?? '未填写相对路径'}{reference.line ? ` · 第 ${reference.line} 行` : ''} · 当前局部调用图没有该函数</small></span></div> }) : <EmptyState text="这个模块还没有关联函数" />}</section><div className="module-boundary"><Info size={16} /><span>当前版本记录业务能力与相关函数。字段映射仍由字段字典统一管理，避免把同一条规则重复维护到多个模块。</span></div></div>
}

function ModuleEditor({ draft, selected, saving, onChange, onAddCurrent, onSave, onClose }: { draft: ModuleDraft; selected?: GraphNode; saving: boolean; onChange: (draft: ModuleDraft) => void; onAddCurrent: () => void; onSave: () => void; onClose: () => void }) {
  const reducedMotion = useReducedMotion()
  return <motion.div className="modal-scrim" initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reducedMotion ? undefined : { opacity: 0 }}><motion.section className="module-editor" role="dialog" aria-modal="true" aria-label="编辑产品功能模块" initial={reducedMotion ? false : { opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reducedMotion ? undefined : { opacity: 0, y: 18, scale: 0.985 }} transition={reducedMotion ? { duration: 0 } : { type: 'spring', duration: 0.32, bounce: 0.06 }}><div className="editor-head"><div><p>{draft.id ? '编辑产品功能模块' : '新建产品功能模块'}</p><h2>{draft.id ? draft.name : '定义一项产品能力'}</h2></div><button aria-label="关闭编辑器" onClick={onClose}><X size={18} /></button></div><label><span>模块名称</span><input autoFocus value={draft.name} maxLength={80} placeholder="例如：母线目标值分配" onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label><label><span>这项能力解决什么问题</span><textarea value={draft.description} maxLength={400} placeholder="用一句话说明这个模块的产品职责。" onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label><section className="editor-functions"><div className="editor-functions__head"><div><span>关联函数</span><small>函数可以跨目录，也可以属于多个模块。</small></div>{selected?.kind === 'definition' && <button className="secondary-button" onClick={onAddCurrent}><Plus size={15} />加入当前函数</button>}</div>{draft.functions.length ? <div className="draft-function-list">{draft.functions.map((item) => <div key={`${item.functionName}:${item.relativePath ?? ''}`}><Braces size={15} /><span><strong>{item.functionName}</strong><small>{item.relativePath ?? '未填写相对路径'}{item.line ? ` · 第 ${item.line} 行` : ''}</small></span><button aria-label={`移除 ${item.functionName}`} onClick={() => onChange({ ...draft, functions: draft.functions.filter((candidate) => candidate !== item) })}><X size={15} /></button></div>)}</div> : <EmptyState text={selected?.kind === 'definition' ? '点击“加入当前函数”，或先在左侧选择一个函数。' : '请先在左侧选择一个函数。'} />}</section><div className="editor-note"><Info size={15} />保存后只创建当前仓库的模块定义，不会更改 C++ 代码、字段字典或 CSV。</div><div className="editor-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={onSave}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '正在保存' : '保存模块'}</button></div></motion.section></motion.div>
}

function DataMetric({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: ReactNode }) {
  return <article className="data-metric"><span className="data-metric__icon">{icon}</span><div><p>{label}</p><strong title={value}>{value}</strong>{sub && <small>{sub}</small>}</div></article>
}

function InspectorSection({ title, count, icon, children }: { title: string; count: number; icon: ReactNode; children: ReactNode }) {
  return <section className="inspector-section"><div className="inspector-section__title">{icon}<span>{title}</span><em>{count}</em></div>{children}</section>
}

function ConnectionRow({ edge, graph, direction, onSelect }: { edge: GraphEdge; graph: Graph; direction: 'in' | 'out'; onSelect: (id: string) => void }) {
  const id = direction === 'out' ? edge.target : edge.source
  const node = graph.nodes.find((item) => item.id === id)
  if (!node) return null
  return <button className="connection-row" onClick={() => onSelect(node.id)}><span className={node.kind === 'external' ? 'connection-dot is-external' : 'connection-dot'} /><span><strong>{node.label}</strong><small>{edge.callSites.length} 个直接调用位置</small></span><ChevronRight size={14} /></button>
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><Info size={14} />{text}</div> }
function EmptyWorkspace({ title, detail }: { title: string; detail: string }) { return <section className="empty-workspace"><Info size={24} /><h3>{title}</h3><p>{detail}</p></section> }
function LoadingWorkspace({ label, compact = false }: { label: string; compact?: boolean }) { return <div className={`loading-workspace ${compact ? 'is-compact' : ''}`}><LoaderCircle className="spin" size={19} />{label}</div> }

export default App
