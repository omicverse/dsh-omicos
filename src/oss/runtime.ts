import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CloudService } from './cloud.js'
import { ScienceService } from './science.js'

export class OssRuntime {
  private closing = false
  private projects = new Map<string, Promise<ScienceService>>()
  private constructor(readonly cloud: CloudService, readonly python: string) {}
  static async open(options: { cloudBase?: string; stateDir?: string; python?: string } = {}): Promise<OssRuntime> {
    return new OssRuntime(await CloudService.open(options.cloudBase || 'https://auth.omicos.cn', join(options.stateDir || join(homedir(), '.omicos-oss'), 'cloud.json')), options.python || 'python3')
  }
  async project(workspace: string): Promise<ScienceService> {
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    await mkdir(resolve(workspace), { recursive: true })
    const path = await realpath(resolve(workspace))
    if (this.closing) throw new Error('OmicOS OSS runtime is shutting down')
    const id = createHash('sha256').update(path).digest('hex').slice(0, 24)
    let service = this.projects.get(id)
    if (!service) {
      service = ScienceService.open(path, this.python)
      this.projects.set(id, service)
      service.catch(() => { if (this.projects.get(id) === service) this.projects.delete(id) })
    }
    return service
  }
  async list(): Promise<Array<{ id: string; workspace: string }>> {
    return Promise.all([...this.projects].map(async ([id, service]) => ({ id, workspace: (await service).workspace })))
  }
  async byId(id: string): Promise<ScienceService> {
    const project = this.projects.get(id)
    if (!project) throw new Error('Project not registered; open it from the trusted Host first')
    return project
  }
  async dispose(): Promise<void> { this.closing = true; await Promise.allSettled([...this.projects.values()].map(async project => (await project).dispose())); this.projects.clear() }
}
