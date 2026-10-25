import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScienceService } from '../src/oss/science.js'
import { inspectAnnDataCode, normalizeAnnDataPlot, plotAnnDataCode } from '../src/oss/anndata.js'
const python = process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3'
let available = false
try { await promisify(execFile)(python, ['-c', 'import anndata, numpy'], { timeout: 30000 }); available = true } catch {}
const wait = async (service: ScienceService, id: string) => {
  for (let i = 0; i < 1500; i++) { const result = service.get(id)!; if (!['queued', 'running'].includes(result.state)) return result; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('AnnData execution did not settle')
}
it('validates bounded AnnData plotting parameters before sending scientific code', () => {
  const settings = { variable: 'adata', embedding: 'X_umap', axes: [0, 1], color: 'none', maxPoints: 5000, seed: 0 }
  expect(normalizeAnnDataPlot(settings).source).toBe('X')
  for (const change of [{ variable: 'adata; __import__("os")' }, { maxPoints: 10001 }, { axes: [0,0] }, { axes: [0,1024] }, { seed: -1 }, { plot: 'distribution', color: 'none' }, { color: 'feature', field: 'g1', source: 'layer', layer: '' }]) expect(() => normalizeAnnDataPlot({ ...settings, ...change })).toThrow()
})
describe.skipIf(!available)('real AnnData inspection preserves scientific state', () => {
  it('renders deterministic sparse-expression previews without mutating X, layers, obs, raw or embeddings', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omicos-anndata-plot-')); const service = await ScienceService.open(workspace, python)
    const submit = async (code: string, operation: string) => wait(service, (await service.submit(code, operation, 'research')).id)
    try {
      const setup = await submit(`import anndata as ad
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
from scipy import sparse
adata = ad.AnnData(sparse.csr_matrix(np.arange(60).reshape(20,3).astype(float)))
adata.var_names = ['g1', 'g2', 'g3']
adata.obs['group'] = pd.Categorical(['A', 'B'] * 9 + [None, 'A'])
adata.obs['qc'] = pd.array(list(range(19)) + [None], dtype='Int64')
adata.obsm['X_umap'] = np.column_stack([np.arange(20), np.arange(20) ** 0.5])
adata.layers['counts'] = adata.X.copy()
adata.raw = adata.copy()
original_x = adata.X.copy()
original_obs = adata.obs.copy(deep=True)
original_embedding = adata.obsm['X_umap'].copy()
original_raw = adata.raw.X.copy()
original_layers = adata.layers['counts'].copy()`, 'plot-fixture')
      expect(setup.state).toBe('succeeded')
      const settings = normalizeAnnDataPlot({ variable: 'adata', embedding: 'X_umap', color: 'feature', field: 'g2', source: 'layer', layer: 'counts', maxPoints: 7, seed: 42 })
      const first = await submit(plotAnnDataCode(settings), 'feature-plot'); const repeated = await submit(plotAnnDataCode(settings), 'repeat-feature-plot')
      expect(first.state, first.error).toBe('succeeded'); expect(first.artifacts.map(item => item.mime)).toEqual(['image/png', 'application/pdf', 'image/svg+xml'])
      const audit = (output: string) => JSON.parse(output.split('\n').find(line => line.startsWith('OMICOS_ANNDATA_PLOT='))!.slice('OMICOS_ANNDATA_PLOT='.length))
      expect(audit(first.output)).toMatchObject({ sampled_n: 7, plotted_n: 7, n_obs_total: 20 })
      expect(audit(first.output).sample_sha256).toBe(audit(repeated.output).sample_sha256)
      const group = await submit(plotAnnDataCode({ ...settings, color: 'obs', field: 'group', maxPoints: 20 }), 'category-plot')
      expect(group.state).toBe('succeeded'); expect(audit(group.output).missing_color_values).toBe(1)
      const distribution = await submit(plotAnnDataCode({ ...settings, plot: 'distribution', color: 'obs', field: 'qc', maxPoints: 20 }), 'distribution')
      expect(distribution.state).toBe('succeeded'); expect(audit(distribution.output).missing_color_values).toBe(1); expect(audit(distribution.output).plotted_n).toBe(19)
      const counts = await submit(plotAnnDataCode({ ...settings, plot: 'distribution', color: 'obs', field: 'group', maxPoints: 20 }), 'category-counts'); expect(counts.state, counts.error).toBe('succeeded'); expect(audit(counts.output).missing_color_values).toBe(1)
      const maskedSetup = await submit('masked = adata.copy()\nmasked.X = np.ma.array(adata.X.toarray(), mask=False)\nmasked.X.mask[0,1] = True', 'masked-fixture'); expect(maskedSetup.state, maskedSetup.error).toBe('succeeded')
      const masked = await submit(plotAnnDataCode({ ...settings, variable: 'masked', source: 'X', maxPoints: 20 }), 'masked-feature'); expect(masked.state, masked.error).toBe('succeeded'); expect(audit(masked.output).missing_color_values).toBe(1)
      const raw = await submit(plotAnnDataCode({ ...settings, source: 'raw' }), 'raw-feature'); expect(raw.state).toBe('succeeded')
      const check = await submit(`assert (adata.X != original_x).nnz == 0
assert (adata.layers['counts'] != original_layers).nnz == 0
assert (adata.raw.X != original_raw).nnz == 0
pd.testing.assert_frame_equal(adata.obs, original_obs)
assert np.array_equal(adata.obsm['X_umap'], original_embedding)
print('ANN_DATA_PRESERVED')`, 'check-preserved')
      expect(check.output).toContain('ANN_DATA_PRESERVED')
      const quotedKey = 'X_umap"); __import__("pathlib").Path("code-injected").touch(); #'; const quoted = await submit(plotAnnDataCode({ ...settings, embedding: quotedKey }), 'quoted-key'); expect(quoted.state).toBe('failed'); expect((await submit('from pathlib import Path\nprint(Path("code-injected").exists())', 'quote-safe')).output).toContain('False')
      const missing = await submit(plotAnnDataCode({ ...settings, embedding: 'missing' }), 'missing-embedding'); expect(missing.state).toBe('failed'); expect(missing.error).toContain('never computes reductions')
    } finally { await service.dispose(); await rm(workspace, { recursive: true, force: true }) }
  }, 60000)
  it('plots read-only backed sparse data and rejects too many categories without touching the file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omicos-anndata-backed-')); const service = await ScienceService.open(workspace, python)
    const submit = async (code: string, operation: string) => wait(service, (await service.submit(code, operation, 'research')).id)
    try {
      expect((await submit(`import anndata as ad
import numpy as np
import matplotlib
matplotlib.use('Agg')
from scipy import sparse
from pathlib import Path
import hashlib
adata = ad.AnnData(sparse.csr_matrix(np.arange(900).reshape(300,3).astype(float)))
adata.var_names = ['g1','g2','g3']
adata.obsm['X_pca'] = np.column_stack([np.arange(300), np.arange(300)])
adata.obs['many'] = [str(v) for v in range(300)]
adata.write_h5ad('backed.h5ad')
backed = ad.read_h5ad('backed.h5ad', backed='r')
original_file_hash = hashlib.sha256(Path('backed.h5ad').read_bytes()).hexdigest()`, 'backed-fixture')).state).toBe('succeeded')
      const settings = normalizeAnnDataPlot({ variable: 'backed', embedding: 'X_pca', color: 'feature', field: 'g1', maxPoints: 150 })
      const plotted = await submit(plotAnnDataCode(settings), 'backed-plot'); expect(plotted.state, plotted.error).toBe('succeeded')
      const refused = await submit(plotAnnDataCode({ ...settings, color: 'obs', field: 'many', maxPoints: 30 }), 'category-limit')
      expect(refused.state).toBe('failed'); expect(refused.error).toContain('more than 20 categories'); expect(refused.artifacts).toHaveLength(0)
      const check = await submit(`assert hashlib.sha256(Path('backed.h5ad').read_bytes()).hexdigest() == original_file_hash
print(backed.isbacked, backed.shape)
backed.file.close()`, 'backed-unchanged')
      expect(check.output).toContain('True (300, 3)')
    } finally { await service.dispose(); await rm(workspace, { recursive: true, force: true }) }
  }, 60000)
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
