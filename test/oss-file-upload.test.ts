import { createHash, webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceManifest } from '../src/client/file-upload.js'
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../src/oss/upload-types.js'
afterEach(()=>vi.unstubAllGlobals())
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
it('hashes file slices in bounded memory with stable source manifest identity and progress',async()=>{
  vi.stubGlobal('crypto',webcrypto);const bytes=Buffer.alloc(UPLOAD_CHUNK_BYTES+3,42);const slices:number[]=[];const progress:number[]=[]
  const source={size:bytes.length,slice(start:number,end:number){slices.push(end-start);return new Blob([bytes.subarray(start,end)])}}
  const result=await sourceManifest(source as Pick<File,'size'|'slice'>,new AbortController().signal,done=>progress.push(done));const chunkHashes=[sha(bytes.subarray(0,UPLOAD_CHUNK_BYTES)),sha(bytes.subarray(UPLOAD_CHUNK_BYTES))]
  expect(result.chunkHashes).toEqual(chunkHashes);expect(result.manifestSha256).toBe(sha(JSON.stringify({bytes:bytes.length,chunkSize:UPLOAD_CHUNK_BYTES,chunkHashes})));expect(Math.max(...slices)).toBe(UPLOAD_CHUNK_BYTES);expect(progress).toEqual([0,UPLOAD_CHUNK_BYTES,bytes.length])
})
it('handles empty files and rejects size/aborted work before reading further slices',async()=>{
  vi.stubGlobal('crypto',webcrypto);expect((await sourceManifest(new File([],'empty'),new AbortController().signal,()=>{})).chunkHashes).toEqual([])
  const slice=vi.fn();await expect(sourceManifest({size:UPLOAD_MAX_BYTES+1,slice} as Pick<File,'size'|'slice'>,new AbortController().signal,()=>{})).rejects.toThrow('10 GiB');expect(slice).not.toHaveBeenCalled()
  const controller=new AbortController();const data=new File([Buffer.alloc(UPLOAD_CHUNK_BYTES+1)],'pause');await expect(sourceManifest(data,controller.signal,done=>{if(done)controller.abort()})).rejects.toMatchObject({name:'AbortError'})
})
