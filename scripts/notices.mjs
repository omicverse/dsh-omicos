import { dirname, join, resolve } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'

/** Include the licenses of exactly the npm packages that esbuild actually inlined. */
export async function writeBundleNotices(name, metafile) {
  const packages = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue
    let directory = dirname(resolve(input))
    for (;;) {
      let manifest
      try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (manifest?.name && manifest.version) {
        const id = `${manifest.name}@${manifest.version}`
        if (!packages.has(id)) {
          const files = (await readdir(directory)).filter(file => /^licen[cs]e([.-].*)?$/i.test(file)).sort()
          if (!files.length) throw new Error(`Bundled ${id} has no packaged license text; resolve its distribution notice before release`)
          const license = (await Promise.all(files.map(async file => `${file}\n${await readFile(join(directory, file), 'utf8')}`))).join('\n\n')
          packages.set(id, { manifest, license })
        }
        break
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`Cannot resolve the npm owner of ${input}`)
      directory = parent
    }
  }
  const parts = ['OmicOS OSS bundled third-party notices.\nThe application itself is GPL-3.0-only; dependencies retain their own licenses.\n']
  for (const [id, { manifest, license }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`\n=== ${id} ===\nDeclared license: ${manifest.license || 'See license text'}\nRepository: ${typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url || manifest.homepage || 'See npm package metadata'}\n\n${license}`)
  }
  await writeFile(`lib/third-party-${name}.txt`, parts.join('\n'))
}
