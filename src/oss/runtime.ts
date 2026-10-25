import { ProjectDossier } from './dossier.js'
import { DossierError } from './dossier-types.js'
import { ScientificMethods } from './methods.js'
import { DataUploads } from './uploads.js'
import { ManagedEnvironments } from './managed-environments.js'
import { ResearchPlans } from './research-plans.js'
import { ResearchPlanError } from './research-plan-types.js'
import { FigureStudio } from './figures.js'
import { FigureError, type FigureSource } from './figure-types.js'
import { artifactBytes } from './artifact-bytes.js'
import { PipelineService } from './pipelines.js'
import type { ScienceChat } from './chat.js'
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { CloudService } from './cloud.js'
import { ScienceService } from './science.js'
import { readJson, writeJson } from './storage.js'

interface ProjectReference { id: string; workspace: string }
const projectId = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24)
export class OssRuntime {
  chat?: ScienceChat
  resolveSessionWorkspace?: (sessionId: string, signal: AbortSignal) => Promise<string>
  private closing = false
  private known = new Map<string, ProjectReference>()
  private registryWrites: Promise<void> = Promise.resolve()
  private dossierProjects = new Map<string, Promise<ProjectDossier>>()
  private methodProjects = new Map<string, Promise<ScientificMethods>>()
  private uploadProjects = new Map<string, Promise<DataUploads>>()
  private environmentProjects = new Map<string, Promise<ManagedEnvironments>>()
  private planProjects = new Map<string, Promise<ResearchPlans>>()
  private figureProjects = new Map<string, Promise<FigureStudio>>()
  private pipelineProjects = new Map<string, Promise<PipelineService>>()
  private rProjects = new Map<string, Promise<ScienceService>>()
  private projects = new Map<string, Promise<ScienceService>>()
  private constructor(readonly cloud: CloudService, readonly python: string, readonly rscript: string, private stateDir: string, private envNames: readonly string[]) {}
  static async open(options: { cloudBase?: string; stateDir?: string; python?: string; rscript?: string; workerEnvNames?: readonly string[] } = {}): Promise<OssRuntime> {
    const stateDir = resolve(options.stateDir || join(homedir(), '.omicos-oss'))
    const runtime = new OssRuntime(await CloudService.open(options.cloudBase || 'https://auth.omicos.cn', join(stateDir, 'cloud.json')), options.python || 'python3', options.rscript || 'Rscript', stateDir, options.workerEnvNames || [])
    const registry = await readJson<{ protocol: number; projects: ProjectReference[] }>(join(stateDir, 'projects.json'), { protocol: 1, projects: [] })
    if (registry.protocol !== 1 || !Array.isArray(registry.projects)) throw new Error('Unsupported project registry; preserve the file and use a compatible runtime')
    for (const entry of registry.projects) {
      if (typeof entry?.workspace !== 'string' || !isAbsolute(entry.workspace) || projectId(entry.workspace) !== entry.id) throw new Error('Invalid persisted project identity; refusing to open an unintended directory')
      runtime.known.set(entry.id, entry)
    }
    return runtime
  }
  get stateDirectory(): string { return this.stateDir }
  get sensitiveFiles(): readonly string[] { return [...this.cloud.sensitiveFiles, join(this.stateDir, 'http-owner.json'), join(this.stateDir, 'projects.json')] }
  private saveRegistry(): Promise<void> {
    const snapshot = { protocol: 1, projects: [...this.known.values()] }
    const write = this.registryWrites.then(() => writeJson(join(this.stateDir, 'projects.json'), snapshot))
    this.registryWrites = write.catch(() => {})
    return write
  }
  async project(workspace: string): Promise<ScienceService> {
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    await mkdir(resolve(workspace), { recursive: true })
    const path = await realpath(resolve(workspace))
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    const id = projectId(path)
    let service = this.projects.get(id)
    if (!service) {
      service = ScienceService.open(path, this.python, 'python', this.envNames).then(async service => {
        try {
          const managerPromise = ManagedEnvironments.open(service.workspace, this.python, this.sensitiveFiles)
          this.environmentProjects.set(id, managerPromise)
          const manager = await managerPromise
          try { service.configureColdInterpreter(await manager.selectedInterpreter(), undefined, Boolean(manager.selection().environmentId)) }
          catch (error) { service.configureColdInterpreter(this.python, `Selected Python environment is unavailable: ${String(error)}. Open managed environments and explicitly choose a rollback for the next Host start.`) }
          this.known.set(id, { id, workspace: service.workspace })
          await this.saveRegistry()
          return service
        } catch (error) { const manager = this.environmentProjects.get(id); this.environmentProjects.delete(id); if (manager) await (await manager.catch(() => undefined))?.dispose(); await service.dispose(); throw error }
      })
      this.projects.set(id, service)
      service.catch(() => { if (this.projects.get(id) === service) this.projects.delete(id) })
    }
    return service
  }
  async rProject(workspace: string): Promise<ScienceService> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.rProjects.get(parent.workspace)
    if (!service) {
      service = ScienceService.open(parent.workspace, this.rscript, 'r', this.envNames)
      this.rProjects.set(parent.workspace, service)
      service.catch(() => { if (this.rProjects.get(parent.workspace) === service) this.rProjects.delete(parent.workspace) })
    }
    return service
  }
  async pipelines(workspace: string): Promise<PipelineService> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.pipelineProjects.get(parent.workspace)
    if (!service) {
      service = this.methods(parent.workspace).then(methods => PipelineService.open(parent.workspace, parent.python, this.rscript, this.envNames, this.sensitiveFiles, parent.executionUnavailable, parent.usesIsolatedPython, references => methods.validateReferences(references)))
      this.pipelineProjects.set(parent.workspace, service)
      service.catch(() => { if (this.pipelineProjects.get(parent.workspace) === service) this.pipelineProjects.delete(parent.workspace) })
    }
    return service
  }
  async dossier(workspace: string): Promise<ProjectDossier> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.dossierProjects.get(parent.workspace)
    if (!service) {
      service = ProjectDossier.open(parent.workspace, async source => {
        if (source.kind === 'execution' || source.kind === 'pipeline-execution') {
          const pipelines = source.kind === 'pipeline-execution' ? await this.pipelines(parent.workspace) : undefined
          const execution = pipelines ? await pipelines.execution(source.runId!, source.id, true) : parent.receipt(source.id)
          if (!execution) throw new DossierError(404, 'Committed execution receipt not found')
          if (!['succeeded','failed','canceled','interrupted'].includes(execution.state)) throw new DossierError(409, 'Wait for a terminal execution receipt before capturing dossier evidence')
          const run = pipelines?.get(source.runId!)
          return { scope: 'Committed execution/code/output/environment/artifact metadata; no exhaustive input I/O or scientific validity inference.', data: { execution, ...(run ? { runId:run.id,definitionId:run.definitionId,methodReviews:run.attempts.find(attempt=>attempt.executionId===execution.id)?.methodReviews } : {}) } }
        }
        if (source.kind === 'import') {
          const record = (await this.uploads(parent.workspace)).get(source.id)
          if (record.state !== 'completed') throw new DossierError(409, 'Only committed imports can be evidence snapshots')
          return { scope: 'Import-time receipt/whole-file identity only; current dataset bytes are not read or verified.', data: { id:record.id,state:record.state,target:record.target,bytes:record.bytes,sha256:record.sha256,manifestSha256:record.manifestSha256,expectedSha256:record.expectedSha256,createdAt:record.createdAt } }
        }
        if (source.kind === 'method') return { scope:'Current immutable method document and local human publication state; declarations are not independent scientific/legal validation.',data:(await this.methods(parent.workspace)).get(source.id) }
        if (source.kind === 'figure') {
          const figures = await this.figures(parent.workspace); const figure = figures.get(source.id); const integrity = await figures.integrity(source.id,figure.revision)
          if (integrity.state !== 'verified') throw new DossierError(409,`Figure bytes unavailable/changed: ${integrity.reason}`)
          return { scope:'Current figure revision; artifact bytes checked but not embedded in this snapshot. Figure interpretation and declared sources are not independently validated.',data:{figure,artifactIntegrity:'verified'} }
        }
        if (source.kind === 'notebook') return {scope:'Editable Notebook revision and saved execution links; imported rich outputs remain unverified.',data:parent.notebooks.get(source.id)}
        return {scope:'Scientific plan definitions and human task assessments; not independent scientific validation.',data:(await this.researchPlans(parent.workspace)).get(source.id)}
      })
      this.dossierProjects.set(parent.workspace,service); service.catch(()=>{if(this.dossierProjects.get(parent.workspace)===service)this.dossierProjects.delete(parent.workspace)})
    }
    return service
  }
  async methods(workspace: string): Promise<ScientificMethods> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.methodProjects.get(parent.workspace)
    if (!service) { service = ScientificMethods.open(parent.workspace); this.methodProjects.set(parent.workspace, service); service.catch(() => { if (this.methodProjects.get(parent.workspace) === service) this.methodProjects.delete(parent.workspace) }) }
    return service
  }
  async uploads(workspace: string): Promise<DataUploads> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.uploadProjects.get(parent.workspace)
    if (!service) { service = DataUploads.open(parent.workspace, this.sensitiveFiles); this.uploadProjects.set(parent.workspace, service); service.catch(() => { if (this.uploadProjects.get(parent.workspace) === service) this.uploadProjects.delete(parent.workspace) }) }
    return service
  }
  async managedEnvironments(workspace: string): Promise<ManagedEnvironments> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    return this.environmentProjects.get(projectId(parent.workspace))!
  }
  async researchPlans(workspace: string): Promise<ResearchPlans> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.planProjects.get(parent.workspace)
    if (!service) {
      service = ResearchPlans.open(parent.workspace, async source => {
        if (source.kind === 'pipeline') return (await this.pipelines(parent.workspace)).execution(source.runId!, source.executionId, true)
        const execution = parent.receipt(source.executionId)
        if (!execution) throw new ResearchPlanError(404, 'Project execution receipt not found')
        return execution
      })
      this.planProjects.set(parent.workspace, service); service.catch(() => { if (this.planProjects.get(parent.workspace) === service) this.planProjects.delete(parent.workspace) })
    }
    return service
  }
  async figures(workspace: string): Promise<FigureStudio> {
    const parent = await this.project(workspace)
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    let service = this.figureProjects.get(parent.workspace)
    if (!service) {
      service = FigureStudio.open(parent.workspace, async (source: FigureSource) => {
        if (source.kind === 'pipeline') {
          const pipelines = await this.pipelines(parent.workspace); const execution = await pipelines.execution(source.runId!, source.executionId)
          if (execution.language !== source.language) throw new FigureError(400, 'Figure language does not match execution')
          const artifact = execution.artifacts.find(item => item.id === source.artifactId); if (!artifact) throw new FigureError(404, 'Execution artifact not found')
          return { execution, artifact, bytes: (await pipelines.artifact(source.runId!, execution.id, artifact.id)).bytes }
        }
        const execution = parent.receipt(source.executionId)
        if (!execution || execution.language !== source.language) throw new FigureError(404, 'Project execution receipt not found')
        const artifact = execution.artifacts.find(item => item.id === source.artifactId); if (!artifact) throw new FigureError(404, 'Execution artifact not found')
        return { execution, artifact, bytes: await artifactBytes(parent.workspace, artifact) }
      })
      this.figureProjects.set(parent.workspace, service); service.catch(() => { if (this.figureProjects.get(parent.workspace) === service) this.figureProjects.delete(parent.workspace) })
    }
    return service
  }
  async list(): Promise<ProjectReference[]> { return structuredClone([...this.known.values()]) }
  async byId(id: string): Promise<ScienceService> {
    const active = this.projects.get(id)
    if (active) return active
    const reference = this.known.get(id)
    if (!reference) throw new Error('Project not registered; open it from the trusted Host first')
    // A missing directory stays missing. A moved/symlink-replaced path must not silently change identity.
    const actual = await realpath(reference.workspace)
    if (projectId(actual) !== id) throw new Error('Project location changed; reopen it explicitly from the Host')
    return this.project(actual)
  }
  async dispose(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.dossierProjects.values()].map(async service => (await service).dispose()))
    this.dossierProjects.clear()
    await Promise.allSettled([...this.uploadProjects.values()].map(async service => (await service).dispose()))
    this.uploadProjects.clear()
    await Promise.allSettled([...this.environmentProjects.values()].map(async service => (await service).dispose()))
    this.environmentProjects.clear()
    await Promise.allSettled([...this.planProjects.values()].map(async service => (await service).dispose()))
    this.planProjects.clear()
    await Promise.allSettled([...this.figureProjects.values()].map(async service => (await service).dispose()))
    this.figureProjects.clear()
    await Promise.allSettled([...this.pipelineProjects.values()].map(async service => (await service).dispose()))
    this.pipelineProjects.clear()
    await Promise.allSettled([...this.methodProjects.values()].map(async service => (await service).dispose()))
    this.methodProjects.clear()
    await Promise.allSettled([...this.rProjects.values()].map(async project => (await project).dispose()))
    this.rProjects.clear()
    await Promise.allSettled([...this.projects.values()].map(async project => (await project).dispose()))
    this.projects.clear()
    await this.registryWrites
  }
}
