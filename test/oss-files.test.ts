import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listWorkspace, previewWorkspaceFile, workspacePath } from '../src/oss/files.js'
import { inspectAnnDataCode } from '../src/oss/anndata.js'

describe('scientific workspace file boundary', () => {
  let directory: string; let workspace: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'omicos-files-')); workspace = join(directory, 'project'); await mkdir(workspace) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  it('lists project data, bounds previews and omits runtime/hidden metadata', async () => {
    await mkdir(join(workspace, '.omicos-oss')); await writeFile(join(workspace, 'data.csv'), 'sample,value\na,42\n'); await writeFile(join(workspace, 'large.txt'), 'x'.repeat(100000)); await writeFile(join(workspace, '.env'), 'SECRET=private')
    const listing = await listWorkspace(workspace)
    expect(listing.entries.map(file => file.name)).toEqual(['data.csv', 'large.txt'])
    expect((await previewWorkspaceFile(workspace, 'data.csv')).text).toContain('a,42')
    const large = await previewWorkspaceFile(workspace, 'large.txt')
    expect(large.truncated).toBe(true); expect(large.text?.length).toBe(65536)
    await expect(workspacePath(workspace, '.env')).rejects.toThrow('private')
    await expect(workspacePath(workspace, '.omicos-oss/executions.json')).rejects.toThrow('private')
  })
  it('blocks traversal, external symlinks and configured credential aliases', async () => {
    const secret = join(directory, 'cloud.json'); await writeFile(secret, '{"token":"secret"}')
    await symlink(secret, join(workspace, 'external.json'))
    await expect(workspacePath(workspace, '../cloud.json')).rejects.toThrow()
    await expect(previewWorkspaceFile(workspace, 'external.json')).rejects.toThrow('outside')
    const inside = join(workspace, 'state.json'); await writeFile(inside, '{"token":"secret"}')
    await expect(previewWorkspaceFile(workspace, 'state.json', [inside])).rejects.toThrow('credentials')
    expect((await listWorkspace(workspace, '', [inside])).entries).toHaveLength(0)
  })
  it('excludes entire configured runtime caches, including descendant paths and directory aliases',async()=>{
    const cache=join(workspace,'host-cache');await mkdir(cache);await mkdir(join(cache,'payload'));await writeFile(join(cache,'payload','manifest.json'),'private runtime inventory');await symlink(cache,join(workspace,'alias'))
    for(const path of ['host-cache','host-cache/payload/manifest.json','alias/payload/manifest.json'])await expect(workspacePath(workspace,path,[cache])).rejects.toThrow('credentials')
    expect((await listWorkspace(workspace,'',[cache])).entries).toEqual([])
  })
  it('never renders a binary dataset as text or executes it while browsing', async () => {
    await writeFile(join(workspace, 'dataset.h5ad'), Buffer.from([0,1,2,3]))
    expect(await previewWorkspaceFile(workspace, 'dataset.h5ad')).toEqual({ path: 'dataset.h5ad', kind: 'data', bytes: 4 })
    await expect(Promise.resolve().then(() => inspectAnnDataCode('adata;__import__("os")'))).rejects.toThrow('identifier')
    expect(inspectAnnDataCode('adata')).toContain('transform_state')
  })
})
