/**
 * Executes the BUILT client bundle (lib/client.js) against a stubbed
 * module-loader sink — the divergence points of the closure-factory
 * contract (cordis-client-runner runtime.ts:98-101): the load({id,
 * factory}) call shape, externals resolving through the injected require,
 * and the surface being a loader-consumable plugin namespace.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const BUNDLE = new URL('../lib/client.js', import.meta.url).pathname

const PROBE = `
const requests = []
const fakeReact = { createElement: () => null }
const sink = {
  load({ id, factory }) {
    const surface = factory((spec) => {
      requests.push(spec)
      if (spec === 'react' || spec === 'react/jsx-runtime') return { ...fakeReact, jsx: () => null, jsxs: () => null }
      return {}
    })
    console.log(JSON.stringify({
      id,
      name: surface.name,
      inject: surface.inject,
      hasApply: typeof surface.apply === 'function',
      hasDefault: 'default' in surface,
      required: requests,
    }))
  },
}
globalThis.window = { __ModuleLoader__: sink }
require(process.argv[1])
`

describe('built client bundle', () => {
  it('registers via window.__ModuleLoader__.load and exposes the plugin namespace surface', () => {
    expect(existsSync(BUNDLE)).toBe(true)
    const out = execFileSync(process.execPath, ['-e', PROBE, BUNDLE], { encoding: 'utf8' }).trim()
    const result = JSON.parse(out.split('\n').pop()!) as {
      id: string
      name: string
      inject: string[]
      hasApply: boolean
      hasDefault: boolean
      required: string[]
    }
    expect(result.id).toBe('@omicverse/dsh-omicos')
    expect(result.name).toBe('omicos-client')
    expect(result.inject).toEqual(['slots'])
    expect(result.hasApply).toBe(true)
    // No default export — the loader's unwrapExports would take it INSTEAD of the namespace.
    expect(result.hasDefault).toBe(false)
    // Externals stayed external (resolved through the injected require, not inlined).
    expect(result.required).toContain('react/jsx-runtime')
  })
})
