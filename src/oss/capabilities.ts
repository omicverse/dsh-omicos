import { readFileSync } from 'node:fs'
import type { OssRuntime } from './runtime.js'
import { PROTOCOL_VERSION } from './types.js'
export interface RuntimeCapability { id: string; state: 'available' | 'configured' | 'optional' | 'unavailable' | 'unverified'; description: string; requires?: string[]; limits?: string[] }
export function runtimeVersion(): string { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string }
/** Discovery never probes an interpreter, contacts cloud, or reads process environment. */
export function runtimeCapabilities(runtime: OssRuntime, backend: 'oss' | 'core' = 'oss') {
  const version = runtimeVersion()
  const features: RuntimeCapability[] = [
    { id: 'science.python', state: 'configured', description: 'Persistent local Python kernel; selected interpreter/package availability requires explicit environment diagnostics.', requires: ['python'], limits: ['Trusted OS-user code; not a sandbox', 'Exclusive project owner across Host processes'] },
    { id: 'science.r', state: 'configured', description: 'Independent persistent R namespace.', requires: ['Rscript', 'jsonlite'], limits: ['Installation is explicit; no automatic dependency provisioning'] },
    { id: 'science.anndata-explorer', state: 'available', description: 'Approved, non-mutating existing embedding and obs/feature distribution previews.', requires: ['anndata', 'numpy', 'pandas', 'scipy', 'matplotlib'], limits: ['Up to 10000 uniformly sampled observations', 'At most 20 sampled categories', 'No implicit reductions or transforms', 'Preview subset hashes are not full-input provenance'] },
    { id: 'science.environment', state: 'available', description: 'Explicit interpreter/package diagnostics and execution environment fingerprints.' },
    { id: 'science.execution', state: 'available', description: 'Durable paginated SQLite execution history, stable invocation deduplication, cancellation and streamed complete Notebook export.', limits: ['Snapshots show the latest 100 executions; full receipts stay addressable', 'Unknown/interrupted work does not replay automatically', 'Side effects are not exactly once'] },
    { id: 'science.events', state: 'available', description: 'Authenticated SSE with durable event cursors and reconnect replay.' },
    { id: 'notebook', state: 'available', description: 'Persistent editable Python/R documents and actual cell execution links.', limits: ['2 MB per document', '500 cells', '100 documents', 'Imported rich output is not executed'] },
    { id: 'memory', state: 'available', description: 'Revisioned topics, session-private notes, proposals, confirmation and consolidation.', limits: ['Long-term memory is project-local', 'Declared references are not independent scientific verification'] },
    { id: 'figures', state: 'available', description: 'Versioned source-pinned figures, human review, history and provenance export.', limits: ['32 MiB per artifact', 'SVG/PDF download only', 'No automatic scientific reviewer'] },
    { id: 'research.plans', state: 'available', description: 'Revisioned scientific plans, explicit human approval and receipt-backed task assessments.', limits: ['Plan approval never bypasses execution approval', 'Declared methods/data and human completion are not independent scientific verification', 'No automatic execution or delegation'] },
    { id: 'pipeline.local', state: 'available', description: 'Pinned ordered Python/R workflows, isolated kernels, human gates and checkpoint recovery.', limits: ['One language per definition', 'Up to four held local kernels', 'Raw inputs/checkpoints/environment are checked before approved recovery'] },
    { id: 'agent.chat', state: backend === 'core' ? 'unavailable' : runtime.chat ? 'available' : 'optional', description: backend === 'core' ? 'OSS Scientist is disabled in Core compatibility mode.' : runtime.chat ? 'Project-fixed Scientist conversation uses the connected Harness controller.' : 'Connect through a Harness Host to use its model/session controller.', requires: ['Harness session controller', 'Configured Harness model provider'] },
    { id: 'agent.tools', state: backend === 'core' ? 'unavailable' : 'optional', description: 'Scientific tools use Harness approval; no second model loop or automatic permission bypass.', requires: ['Harness ToolRuntime and approval service'] },
    { id: 'cloud.commerce', state: 'optional', description: 'Official account, catalog, confirmed orders, QR recovery, memberships, invoices and lab seats.', requires: ['Official cloud account', 'Compatible reachable billing service'], limits: ['Server owns price, payment and entitlement state', 'No automatic purchases', 'Real merchant callbacks remain unverified'] },
    { id: 'runner.ssh-slurm', state: 'unavailable', description: 'Remote/cluster Runner adapters are not implemented.' },
    { id: 'runtime.provisioning', state: 'unavailable', description: 'Runtime/environment download, installation and rollback are not implemented.' },
    { id: 'desktop.bridge', state: 'unavailable', description: 'Native desktop windows, pets and system actions require a future optional desktop bridge.' },
    { id: 'platform.windows-electron', state: 'unverified', description: 'Full Windows/Electron lifecycle and deployment are not yet verified.' },
  ]
  return { schema: 'omicos.capabilities/1', runtimeVersion: version, protocol: { current: PROTOCOL_VERSION, minimum: PROTOCOL_VERSION, maximum: PROTOCOL_VERSION, requestHeader: 'x-omicos-protocol' }, backend, features }
}

export type RuntimeCapabilities = ReturnType<typeof runtimeCapabilities>
