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
it('validates grouped dotplot bounds, exact identifiers, explicit matrix units and safe canonical settings',()=>{
 const settings={variable:'adata',plot:'dotplot',features:['g1','g2'],groupBy:'group'}
 expect(normalizeAnnDataPlot(settings)).toMatchObject({plot:'dotplot',color:'feature',threshold:0,features:['g1','g2'],groupBy:'group'})
 for(const change of [{features:[]},{features:['g1','g1']},{features:Array.from({length:21},(_,i)=>`g${i}`)},{groupBy:''},{threshold:Infinity},{threshold:'0'},{color:'obs'},{source:'layer'}])expect(()=>normalizeAnnDataPlot({...settings,...change})).toThrow()
 expect(normalizeAnnDataPlot({...settings,axes:[-1,-1]}).axes).toEqual([0,1])
})
it('validates grouped numeric distribution fields and grouping without inheriting unused embedding axes',()=>{
 const base={variable:'adata',plot:'boxplot',color:'feature',field:'g1',groupBy:'batch'}
 expect(normalizeAnnDataPlot({...base,axes:[-1,-1]})).toMatchObject({plot:'boxplot',axes:[0,1],groupBy:'batch'})
 expect(normalizeAnnDataPlot({...base,plot:'violin',color:'obs',field:'qc'})).toMatchObject({plot:'violin',color:'obs',field:'qc'})
 for(const change of [{groupBy:''},{color:'none'},{field:''},{source:'layer'},{maxPoints:10001}])expect(()=>normalizeAnnDataPlot({...base,...change})).toThrow()
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
  it('computes sampled dotplot means and strict fractions from explicit sparse X/layer/raw without mutating scientific objects',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'omicos-dotplot-')),service=await ScienceService.open(workspace,python)
    const submit=async(code:string,operation:string)=>wait(service,(await service.submit(code,operation,'dotplot')).id)
    const audit=(output:string)=>JSON.parse(output.split('\n').find(line=>line.startsWith('OMICOS_ANNDATA_PLOT='))!.slice('OMICOS_ANNDATA_PLOT='.length))
    try{
      expect((await submit(`import anndata as ad
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
from scipy import sparse
values = np.array([[0.,1.,np.nan],[2.,np.nan,np.inf],[4.,0.,3.],[8.,np.inf,4.],[16.,32.,9.]])
adata = ad.AnnData(sparse.csr_matrix(values))
adata.var_names = ['g1','g2','g3']
adata.obs['group'] = pd.Categorical(['A','A','B','B',None])
adata.obs['numeric'] = [0,0,1,1,2]
adata.obs['cluster'] = pd.Categorical([0,0,1,1,None], categories=[1,0], ordered=True)
adata.obs['ambiguous'] = pd.Series([1,'1',1,'1',None], index=adata.obs.index, dtype='object')
adata.layers['complex'] = adata.X.astype(complex)
adata.layers['counts'] = sparse.csr_matrix(values * 2)
raw_copy = adata.copy()
raw_copy.X = sparse.csr_matrix(values + 3)
adata.raw = raw_copy
original_obs = adata.obs.copy(deep=True)`, 'dot-fixture')).state).toBe('succeeded')
      const settings=normalizeAnnDataPlot({variable:'adata',plot:'dotplot',features:['g1','g2'],groupBy:'group',threshold:1,maxPoints:5,seed:7})
      const first=await submit(plotAnnDataCode(settings),'dot-X');expect(first.state,first.error).toBe('succeeded');expect(first.artifacts.map(item=>item.mime)).toEqual(['image/png','application/pdf','image/svg+xml'])
      const data=audit(first.output);expect(data).toMatchObject({sampled_n:5,plotted_n:4,missing_group_n:1,groups:[{label:'A',sampled_n:2},{label:'B',sampled_n:2}]})
      expect(data.cells).toEqual([{groupIndex:0,featureIndex:0,finite_n:2,nonfinite_n:0,above_threshold_n:1,mean:1,fraction:0.5},{groupIndex:1,featureIndex:0,finite_n:2,nonfinite_n:0,above_threshold_n:2,mean:6,fraction:1},{groupIndex:0,featureIndex:1,finite_n:1,nonfinite_n:1,above_threshold_n:0,mean:1,fraction:0},{groupIndex:1,featureIndex:1,finite_n:1,nonfinite_n:1,above_threshold_n:0,mean:0,fraction:0}])
      const repeated=await submit(plotAnnDataCode(settings),'dot-repeat');expect(audit(repeated.output).sample_sha256).toBe(data.sample_sha256)
      const layer=await submit(plotAnnDataCode({...settings,source:'layer',layer:'counts'}),'dot-layer');expect(layer.state,layer.error).toBe('succeeded');expect(audit(layer.output).cells[0].mean).toBe(2);expect(audit(layer.output).sample_sha256).not.toBe(data.sample_sha256)
      const raw=await submit(plotAnnDataCode({...settings,source:'raw'}),'dot-raw');expect(raw.state,raw.error).toBe('succeeded');expect(audit(raw.output).cells[0].mean).toBe(4)
      const missingCell=await submit(plotAnnDataCode({...settings,features:['g3']}),'dot-missing-cell');expect(missingCell.state,missingCell.error).toBe('succeeded');expect(audit(missingCell.output).cells[0]).toMatchObject({finite_n:0,nonfinite_n:2,mean:null,fraction:null})
      const cluster=await submit(plotAnnDataCode({...settings,features:['g1'],groupBy:'cluster'}),'dot-numeric-categories');expect(cluster.state,cluster.error).toBe('succeeded');expect(audit(cluster.output).groups.map((group:any)=>group.label)).toEqual(['1','0']);expect(audit(cluster.output).cells[0].mean).toBe(6)
      const ambiguous=await submit(plotAnnDataCode({...settings,groupBy:'ambiguous'}),'dot-ambiguous');expect(ambiguous.state).toBe('failed');expect(ambiguous.error).toContain('same display text');expect(ambiguous.artifacts).toHaveLength(0)
      const complex=await submit(plotAnnDataCode({...settings,source:'layer',layer:'complex'}),'dot-complex');expect(complex.state).toBe('failed');expect(complex.error).toContain('Complex-valued');expect(complex.artifacts).toHaveLength(0)
      const invalid=await submit(plotAnnDataCode({...settings,groupBy:'numeric'}),'dot-continuous');expect(invalid.state).toBe('failed');expect(invalid.error).toContain('explicit approved categorization');expect(invalid.artifacts).toHaveLength(0)
      const absent=await submit(plotAnnDataCode({...settings,features:['not-a-feature']}),'dot-missing');expect(absent.state).toBe('failed');expect(absent.artifacts).toHaveLength(0)
      const check=await submit(`np.testing.assert_allclose(adata.X.toarray(), values, equal_nan=True)
np.testing.assert_allclose(adata.layers['counts'].toarray(), values * 2, equal_nan=True)
np.testing.assert_allclose(adata.raw.X.toarray(), values + 3, equal_nan=True)
pd.testing.assert_frame_equal(adata.obs, original_obs)
print('DOTPLOT_PRESERVED')`, 'dot-unchanged');expect(check.output).toContain('DOTPLOT_PRESERVED')
    }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
  },60000)
  it('renders audited grouped box/violin distributions with exact quartiles, outliers, ordered groups and explicit constant/missing cases',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'omicos-grouped-distribution-')),service=await ScienceService.open(workspace,python)
    const submit=async(code:string,operation:string)=>wait(service,(await service.submit(code,operation,'grouped')).id)
    const audit=(output:string)=>JSON.parse(output.split('\n').find(line=>line.startsWith('OMICOS_ANNDATA_PLOT='))!.slice('OMICOS_ANNDATA_PLOT='.length))
    try{
      expect((await submit(`import anndata as ad
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
from scipy import sparse
values = np.array([0.,10.,20.,100.,5.,5.,7.,np.nan,np.inf,np.nan,11.])
adata = ad.AnnData(sparse.csr_matrix(values.reshape(-1,1)))
adata.var_names = ['g1']
adata.obs['group'] = pd.Categorical(['A']*4 + ['B']*2 + ['C']*3 + ['D',None], categories=['D','C','B','A'], ordered=True)
adata.obs['qc'] = pd.array(values, dtype='Float64')
adata.obs['complex_qc'] = values.astype(complex)
adata.layers['counts'] = sparse.csr_matrix((values*2).reshape(-1,1))
raw_copy = adata.copy()
raw_copy.X = sparse.csr_matrix((values+10).reshape(-1,1))
adata.raw = raw_copy
original_obs = adata.obs.copy(deep=True)`, 'grouped-fixture')).state).toBe('succeeded')
      const settings=normalizeAnnDataPlot({variable:'adata',plot:'boxplot',color:'feature',field:'g1',groupBy:'group',maxPoints:11,seed:5})
      const box=await submit(plotAnnDataCode(settings),'grouped-box');expect(box.state,box.error).toBe('succeeded');expect(box.artifacts.map(item=>item.mime)).toEqual(['image/png','application/pdf','image/svg+xml'])
      const data=audit(box.output);expect(data).toMatchObject({sampled_n:11,plotted_n:7,missing_group_n:1,value_source:{kind:'feature',field:'g1',source:'X'}});expect(data.groups.map((group:any)=>group.label)).toEqual(['D','C','B','A'])
      expect(data.groups.find((group:any)=>group.label==='A')).toMatchObject({finite_n:4,nonfinite_n:0,min:0,q1:7.5,median:15,q3:40,max:100,mean:32.5,whiskerLow:0,whiskerHigh:40,outlier_n:1})
      expect(data.groups[0]).toMatchObject({finite_n:0,mean:null,median:null,rendering:'no-finite-values'});expect(data.groups[1]).toMatchObject({finite_n:1,nonfinite_n:2,median:7})
      const repeat=await submit(plotAnnDataCode(settings),'grouped-repeat');expect(audit(repeat.output).sample_sha256).toBe(data.sample_sha256)
      const violin=await submit(plotAnnDataCode({...settings,plot:'violin'}),'grouped-violin');expect(violin.state,violin.error).toBe('succeeded');const distributions=audit(violin.output);expect(distributions.groups.map((group:any)=>group.rendering)).toEqual(['no-finite-values','constant-marker','constant-marker','violin'])
      const obs=await submit(plotAnnDataCode({...settings,color:'obs',field:'qc'}),'grouped-obs');expect(obs.state,obs.error).toBe('succeeded');expect(audit(obs.output).value_source).toEqual({kind:'obs',field:'qc'});expect(audit(obs.output).groups.find((group:any)=>group.label==='A').q3).toBe(40)
      for(const [source,mean] of [['layer',65],['raw',42.5]] as const){const result=await submit(plotAnnDataCode({...settings,source,layer:'counts'}),`grouped-${source}`);expect(result.state,result.error).toBe('succeeded');expect(audit(result.output).groups.find((group:any)=>group.label==='A').mean).toBeCloseTo(mean)}
      const nonnumeric=await submit(plotAnnDataCode({...settings,color:'obs',field:'group'}),'grouped-nonnumeric');expect(nonnumeric.state).toBe('failed');expect(nonnumeric.artifacts).toHaveLength(0)
      const complex=await submit(plotAnnDataCode({...settings,color:'obs',field:'complex_qc'}),'grouped-complex');expect(complex.state).toBe('failed');expect(complex.error).toContain('Complex-valued obs');expect(complex.artifacts).toHaveLength(0)
      const check=await submit(`np.testing.assert_allclose(adata.X.toarray().ravel(), values, equal_nan=True)
np.testing.assert_allclose(adata.layers['counts'].toarray().ravel(), values*2, equal_nan=True)
np.testing.assert_allclose(adata.raw.X.toarray().ravel(), values+10, equal_nan=True)
pd.testing.assert_frame_equal(adata.obs, original_obs)
print('GROUPED_DISTRIBUTION_PRESERVED')`, 'grouped-preserved');expect(check.output).toContain('GROUPED_DISTRIBUTION_PRESERVED')
    }finally{await service.dispose();await rm(workspace,{recursive:true,force:true})}
  },60000)
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
adata.obs['group'] = ['A','B'] * 150
adata.write_h5ad('backed.h5ad')
backed = ad.read_h5ad('backed.h5ad', backed='r')
original_file_hash = hashlib.sha256(Path('backed.h5ad').read_bytes()).hexdigest()`, 'backed-fixture')).state).toBe('succeeded')
      const settings = normalizeAnnDataPlot({ variable: 'backed', embedding: 'X_pca', color: 'feature', field: 'g1', maxPoints: 150 })
      const plotted = await submit(plotAnnDataCode(settings), 'backed-plot'); expect(plotted.state, plotted.error).toBe('succeeded')
      const box=await submit(plotAnnDataCode(normalizeAnnDataPlot({variable:'backed',plot:'boxplot',color:'feature',field:'g1',groupBy:'group',maxPoints:150})),'backed-box');expect(box.state,box.error).toBe('succeeded')
      const dot=await submit(plotAnnDataCode(normalizeAnnDataPlot({variable:'backed',plot:'dotplot',features:['g1','g2'],groupBy:'group',maxPoints:150})),'backed-dot');expect(dot.state,dot.error).toBe('succeeded')
      const tooMany=await submit(plotAnnDataCode(normalizeAnnDataPlot({variable:'backed',plot:'dotplot',features:['g1'],groupBy:'many',maxPoints:30})),'dot-category-limit');expect(tooMany.state).toBe('failed');expect(tooMany.error).toContain('1–20 observed');expect(tooMany.artifacts).toHaveLength(0)
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
