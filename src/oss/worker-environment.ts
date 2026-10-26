/** Deliberate environment projection, not a sandbox: the Worker still has the user's OS permissions. */
const RUNTIME_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'DISPLAY', 'XDG_RUNTIME_DIR',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CONDA_DLL_SEARCH_MODIFICATION_ENABLE',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'R_HOME', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE', 'R_ENVIRON_USER', 'R_PROFILE_USER',
  'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
  'NUMBA_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'CUDA_HOME', 'CUDA_VISIBLE_DEVICES',
  'HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'TRANSFORMERS_CACHE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
])
export function workerEnvironment(source: NodeJS.ProcessEnv, additionalNames: readonly string[] = []): NodeJS.ProcessEnv {
  if (additionalNames.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw new Error('Additional worker environment entries must be variable names, not values')
  const explicit = new Set(additionalNames)
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (RUNTIME_NAMES.has(name.toUpperCase()) || /^LC_[A-Z_]+$/.test(name.toUpperCase()) || explicit.has(name))) result[name] = value
  }
  result.MPLBACKEND = 'Agg'
  return result
}
