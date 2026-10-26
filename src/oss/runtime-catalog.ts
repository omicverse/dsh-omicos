import type { BaseRuntimeSpec } from './base-runtime-types.js'
/** Explicit, immutable upstream release pin. Catalog loading never downloads or executes it. */
export const BASE_RUNTIME_CATALOG: readonly BaseRuntimeSpec[] = [
  {
    schema: 'omicos.python-runtime/1',
    title: 'CPython 3.12.15 · python-build-standalone 20261021',
    version: '3.12.15',
    platform: 'darwin',
    arch: 'arm64',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-aarch64-apple-darwin-install_only.tar.gz',
    allowedOrigins: [
      'https://github.com',
      'https://release-assets.githubusercontent.com'
    ],
    sha256: 'a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584',
    bytes: 25158763,
    entrypoint: 'python/bin/python3.12',
    license: {
      id: 'Python-2.0 and bundled component licenses',
      url: 'https://gregoryszorc.com/docs/python-build-standalone/main/distributions.html'
    }
  }
]
