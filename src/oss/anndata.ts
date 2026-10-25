/** Generate a bounded metadata inspection cell; no heavy reductions/densification. */
export function inspectAnnDataCode(variable: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(variable)) throw new Error('AnnData variable must be a simple Python identifier')
  return `import json as _omicos_json
_omicos_object = globals().get(${JSON.stringify(variable)})
if _omicos_object is None:
    raise ValueError('Requested object does not exist in this project kernel')
from anndata import AnnData as _omicos_AnnData
if not isinstance(_omicos_object, _omicos_AnnData):
    raise TypeError('Requested object is not an AnnData instance')
_omicos_audit = {
    'variable': ${JSON.stringify(variable)},
    'type': type(_omicos_object).__name__,
    'shape': list(_omicos_object.shape),
    'is_view': bool(_omicos_object.is_view),
    'isbacked': bool(_omicos_object.isbacked),
    'filename': str(_omicos_object.filename) if _omicos_object.filename else None,
    'X': {'dtype': str(_omicos_object.X.dtype) if _omicos_object.X is not None else None,
          'shape': list(_omicos_object.X.shape) if _omicos_object.X is not None else None},
    'raw_shape': list(_omicos_object.raw.shape) if _omicos_object.raw is not None else None,
    'obs_columns': [str(v) for v in list(_omicos_object.obs.columns)[:100]],
    'var_columns': [str(v) for v in list(_omicos_object.var.columns)[:100]],
    'layers': [str(v) for v in list(_omicos_object.layers.keys())[:100]],
    'obsm': [str(v) for v in list(_omicos_object.obsm.keys())[:100]],
    'uns_keys': [str(v) for v in list(_omicos_object.uns.keys())[:100]],
    'obs_names_unique': bool(_omicos_object.obs_names.is_unique),
    'var_names_unique': bool(_omicos_object.var_names.is_unique),
    'transform_state': 'unknown: metadata markers alone do not prove normalization or log-transform history',
    'evidence_scope': 'object metadata inspection only; raw counts and statistical validity are not inferred'
}
print(_omicos_json.dumps(_omicos_audit, ensure_ascii=True))
del _omicos_object, _omicos_audit`
}
