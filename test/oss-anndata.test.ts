import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScienceService } from '../src/oss/science.js'
import { inspectAnnDataCode } from '../src/oss/anndata.js'
const python = process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3'
let available = false
try { await promisify(execFile)(python, ['-c', 'import anndata, numpy'], { timeout: 30000 }); available = true } catch {}
const wait = async (service: ScienceService, id: string) => {
  for (let i = 0; i < 1500; i++) { const result = service.get(id)!; if (!['queued', 'running'].includes(result.state)) return result; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('AnnData execution did not settle')
}
describe.skipIf(!available)('real AnnData inspection preserves scientific state', () => {
  it('inspects layers/embeddings/markers without changing X or inferring transforms', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omicos-anndata-'))
    const service = await ScienceService.open(workspace, python)
    try {
      const data = await service.submit(`import anndata as ad\nimport numpy as np\nadata = ad.AnnData(np.array([[1.,2.],[3.,4.]]))\nexpected = adata.X.copy()\nadata.layers['counts'] = adata.X.copy()\nadata.obsm['X_umap'] = np.zeros((2,2))\nadata.uns['log1p'] = {'base': None}`, 'fixture', 'research')
      expect((await wait(service, data.id)).state).toBe('succeeded')
      const audit = await service.submit(inspectAnnDataCode('adata'), 'audit', 'research')
      const result = await wait(service, audit.id)
      expect(result.state).toBe('succeeded')
      const metadata = JSON.parse(result.output.trim())
      expect(metadata.shape).toEqual([2,2]); expect(metadata.layers).toContain('counts'); expect(metadata.obsm).toContain('X_umap')
      expect(metadata.transform_state).toMatch(/^unknown/)
      const check = await service.submit('print(np.array_equal(adata.X, expected))', 'unchanged', 'research')
      expect((await wait(service, check.id)).output).toContain('True')
    } finally { await service.dispose(); await rm(workspace, { recursive: true, force: true }) }
  }, 60000)
})
