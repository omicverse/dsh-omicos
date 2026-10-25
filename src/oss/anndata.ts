/** Generate a bounded metadata inspection cell; no heavy reductions/densification. */
export function inspectAnnDataCode(variable: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(variable)) throw new AnnDataError(400, 'AnnData variable must be a simple Python identifier')
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
    'obs_schema': [{'name': str(name), 'dtype': str(dtype)} for name, dtype in list(_omicos_object.obs.dtypes.items())[:100]],
    'embedding_shapes': {str(key): list(_omicos_object.obsm[key].shape) for key in list(_omicos_object.obsm.keys())[:100] if hasattr(_omicos_object.obsm[key], 'shape')},
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

export class AnnDataError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export interface AnnDataPlot { variable: string; plot: 'embedding' | 'distribution' | 'dotplot';features?:string[];groupBy?:string;threshold?:number; embedding?: string; axes: [number, number]; color: 'none' | 'obs' | 'feature'; field?: string; source: 'X' | 'layer' | 'raw'; layer?: string; maxPoints: number; seed: number }
export function normalizeAnnDataPlot(input: any): AnnDataPlot {
  if (!input || typeof input !== 'object' || !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(input.variable)) throw new AnnDataError(400, 'AnnData variable must be a simple Python identifier')
  const name = (value: unknown, label: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new AnnDataError(400, `Invalid ${label}`); return value }
  const plot = input.plot ?? 'embedding'; const color = input.color ?? (plot==='dotplot'?'feature':'none'); const source = input.source ?? 'X'; const axes = plot==='dotplot'?[0,1]:(input.axes ?? [0, 1]); const maxPoints = input.maxPoints ?? 5000; const seed = input.seed ?? 0
  if (!['embedding', 'distribution','dotplot'].includes(plot) || !['none', 'obs', 'feature'].includes(color) || !['X', 'layer', 'raw'].includes(source)) throw new AnnDataError(400, 'Invalid AnnData plot/color/matrix source')
  if (!Array.isArray(axes) || axes.length !== 2 || axes.some(value => !Number.isInteger(value) || value < 0 || value > 1023) || axes[0] === axes[1]) throw new AnnDataError(400, 'Choose two distinct zero-based embedding dimensions (0–1023)')
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 10000 || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new AnnDataError(400, 'Use 1–10000 observations and an integer seed (0–2147483647)')
  if (plot === 'distribution' && color === 'none') throw new AnnDataError(400, 'A distribution needs an explicit obs field or feature')
  let dot:Pick<AnnDataPlot,'features'|'groupBy'|'threshold'>={}
  if(plot==='dotplot'){
    if(color!=='feature'||!Array.isArray(input.features)||input.features.length<1||input.features.length>20)throw new AnnDataError(400,'A dotplot needs feature values and 1–20 explicit feature identifiers')
    const features=input.features.map((value:unknown)=>name(value,'dotplot feature'));if(new Set(features).size!==features.length)throw new AnnDataError(400,'Dotplot features must be unique')
    const threshold=input.threshold??0;if(typeof threshold!=='number'||!Number.isFinite(threshold))throw new AnnDataError(400,'Dotplot threshold must be finite and expressed in the selected matrix units')
    dot={features,groupBy:name(input.groupBy,'categorical obs grouping field'),threshold}
  }
  return { variable: input.variable, plot, ...(plot === 'embedding' ? { embedding: name(input.embedding, 'existing embedding key') } : {}), axes: [axes[0], axes[1]], color, ...dot, ...(color !== 'none' && plot!=='dotplot' ? { field: name(input.field, 'obs field/feature identifier') } : {}), source, ...(color === 'feature' && source === 'layer' ? { layer: name(input.layer, 'layer name') } : {}), maxPoints, seed }
}
/** Only selected embedding columns / bounded sampled expression columns are materialized. No AnnData write or preprocessing. */
export function plotAnnDataCode(input: AnnDataPlot): string {
  const settings = normalizeAnnDataPlot(input)
  return `def _omicos_plot_ann_data():
    import json, hashlib
    import numpy as np
    import pandas as pd
    import matplotlib.pyplot as plt
    from anndata import AnnData
    from scipy import sparse
    import h5py
    try:
        from anndata.abc import CSRDataset, CSCDataset
    except ImportError:
        from anndata.experimental import CSRDataset, CSCDataset
    settings = json.loads(${JSON.stringify(JSON.stringify(settings))})
    obj = globals().get(settings['variable'])
    if not isinstance(obj, AnnData):
        raise TypeError('Requested variable is not an AnnData instance in this Python kernel')
    total = int(obj.n_obs)
    if total < 1:
        raise ValueError('No observations to plot')
    indices = np.sort(np.random.default_rng(settings['seed']).choice(total, size=min(total, settings['maxPoints']), replace=False))
    names = [str(value) for value in obj.obs_names[indices]]
    if any(len(value) > 200 for value in names):
        raise ValueError('Observation identifiers exceed the bounded preview limit')
    def column(matrix, index):
        dtype = getattr(matrix, 'dtype', None)
        if dtype is not None and np.issubdtype(np.dtype(dtype), np.complexfloating):
            raise TypeError('Complex-valued data requires explicit real/imaginary handling before plotting')
        if not isinstance(matrix, (np.ndarray, pd.DataFrame, h5py.Dataset, CSRDataset, CSCDataset)) and not sparse.issparse(matrix):
            raise TypeError('Unsupported lazy/device array backend; prepare explicit approved plotting code instead')
        if isinstance(matrix, pd.DataFrame):
            result = matrix.iloc[indices, index].to_numpy(copy=True)
        elif sparse.issparse(matrix) or isinstance(matrix, (CSRDataset, CSCDataset)):
            chunks = []
            for start in range(0, indices.size, 128):
                selected = matrix[indices[start:start+128], index]
                if sparse.issparse(selected):
                    selected = selected.toarray()
                chunks.append(np.asarray(selected, dtype=float).reshape(-1))
            result = np.concatenate(chunks)
        else:
            result = matrix[indices, index]
        if np.iscomplexobj(result):
            raise TypeError('Complex-valued data requires explicit real/imaginary handling before plotting')
        if np.ma.isMaskedArray(result):
            result = result.astype(float).filled(np.nan)
        result = np.asarray(result, dtype=float).reshape(-1)
        if result.size != indices.size:
            raise ValueError('Selected column is not aligned with observations')
        return result.copy()
    if settings['plot'] == 'dotplot':
        group_field = settings['groupBy']
        if group_field not in obj.obs:
            raise KeyError('Requested grouping obs field does not exist')
        series = obj.obs[group_field].iloc[indices]
        if isinstance(series, pd.DataFrame):
            raise ValueError('Grouping obs field is duplicated; use unique metadata column names')
        if pd.api.types.is_numeric_dtype(series.dtype) and not pd.api.types.is_bool_dtype(series.dtype) and not isinstance(series.dtype, pd.CategoricalDtype):
            raise ValueError('Dotplot grouping must be categorical, string or boolean; numeric measurements need explicit approved categorization first')
        groups = []
        identities = {}
        for value in series.tolist():
            if value is not None and value is not pd.NA and not isinstance(value, (str, bool, np.bool_, int, np.integer, float, np.floating)):
                raise ValueError('Unsupported grouping label type; prepare explicit scalar categories')
            if pd.isna(value):
                groups.append(None)
                continue
            label = str(value)
            if len(label) > 500:
                raise ValueError('Category labels exceed 500 characters')
            identity = (type(value).__name__, repr(value))
            if label in identities and identities[label] != identity:
                raise ValueError('Distinct grouping labels have the same display text; prepare unambiguous explicit labels')
            identities[label] = identity
            groups.append(label)
        categorical = isinstance(series.dtype, pd.CategoricalDtype)
        if categorical:
            order = {label: int(code) for label, code in zip(groups, series.cat.codes.to_numpy()) if label is not None}
            labels = sorted(identities, key=lambda label: order[label])
        else:
            labels = sorted(identities)
        if not labels or len(labels) > 20:
            raise ValueError('Dotplot needs 1–20 observed non-missing sample categories')
        selected = obj.raw if settings['source'] == 'raw' else obj
        if selected is None:
            raise ValueError('Requested raw matrix is absent')
        if not selected.var_names.is_unique:
            raise ValueError('Feature identifiers are not unique; resolve them explicitly')
        for feature in settings['features']:
            if feature not in selected.var_names:
                raise KeyError('Feature identifier does not exist in the selected matrix source: ' + feature)
        if settings['source'] == 'layer':
            if settings.get('layer') not in obj.layers:
                raise KeyError('Requested expression layer is absent')
            matrix = obj.layers[settings['layer']]
        else:
            matrix = selected.X
        if matrix is None:
            raise ValueError('Selected expression matrix is absent')
        masks = [np.asarray([value == label for value in groups], dtype=bool) for label in labels]
        names_hash = hashlib.sha256()
        for name in names:
            encoded = name.encode('utf-8'); names_hash.update(len(encoded).to_bytes(4, 'big')); names_hash.update(encoded)
        sample_hash = hashlib.sha256()
        def include(value):
            encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()
            sample_hash.update(len(encoded).to_bytes(8, 'big')); sample_hash.update(encoded)
        include({'settings': settings, 'indices': indices.tolist(), 'groups': groups, 'group_order': labels, 'obs_names_sha256': names_hash.hexdigest()})
        cells = []
        for feature_index, feature in enumerate(settings['features']):
            values = column(matrix, int(selected.var_names.get_loc(feature)))
            include({'feature': feature, 'values': [float(value) if np.isfinite(value) else None for value in values]})
            for group_index, mask in enumerate(masks):
                selected_values = values[mask]
                finite = np.isfinite(selected_values)
                n = int(finite.sum())
                mean = float(np.mean(selected_values[finite])) if n else None
                if mean is not None and not np.isfinite(mean):
                    raise ValueError('Sample mean overflowed; prepare explicit numeric handling before plotting')
                above = int((selected_values[finite] > settings['threshold']).sum())
                cells.append({'groupIndex': group_index, 'featureIndex': feature_index, 'finite_n': n, 'nonfinite_n': int((~finite).sum()), 'above_threshold_n': above, 'mean': mean, 'fraction': above / n if n else None})
        finite_cells = [cell for cell in cells if cell['finite_n']]
        if not finite_cells:
            raise ValueError('No finite values in the grouped sample')
        figure, ax = plt.subplots(figsize=(max(7, len(settings['features']) * 0.45 + 3), max(5, len(labels) * 0.4 + 2)))
        dots = ax.scatter([cell['featureIndex'] for cell in finite_cells], [cell['groupIndex'] for cell in finite_cells], s=[400 * cell['fraction'] for cell in finite_cells], c=[cell['mean'] for cell in finite_cells], cmap='viridis', linewidths=0)
        missing_cells = [cell for cell in cells if not cell['finite_n']]
        if missing_cells:
            ax.scatter([cell['featureIndex'] for cell in missing_cells], [cell['groupIndex'] for cell in missing_cells], s=30, c='#999999', marker='x', label='No finite values')
        for fraction in [0.0, 0.25, 0.5, 1.0]:
            ax.scatter([], [], s=400 * fraction, c='#777777', linewidths=0, label=('0% (no dot)' if fraction == 0 else str(int(fraction * 100)) + '%'))
        ax.legend(title='Fraction > threshold (finite observations)', loc='upper left', bbox_to_anchor=(1.02, -0.10), fontsize=8)
        source_label = ('layer:' + settings['layer']) if settings['source'] == 'layer' else settings['source']
        figure.colorbar(dots, ax=ax, label='Sample mean; no transform [' + source_label + ']')
        display = lambda label, index: label if len(label) < 80 else label[:70] + '… [' + str(index+1) + ']'
        ax.set_xticks(range(len(settings['features'])), [display(value, i) for i, value in enumerate(settings['features'])], rotation=45, ha='right')
        ax.set_yticks(range(len(labels)), [display(value, i) for i, value in enumerate(labels)])
        ax.set_xlim(-0.6, len(settings['features']) - 0.4); ax.set_ylim(len(labels) - 0.4, -0.6)
        ax.set_xlabel('Selected feature identifiers'); ax.set_ylabel('obs: ' + group_field)
        missing_groups = sum(value is None for value in groups)
        ax.set_title(settings['variable'] + ' · dotplot · threshold > ' + str(settings['threshold']) + ' · ' + str(indices.size - missing_groups) + '/' + str(total) + ' observations')
        figure.tight_layout()
        return {'schema': 'omicos.anndata-plot/1', 'settings': settings, 'n_obs_total': total, 'sampled_n': int(indices.size), 'plotted_n': int(indices.size - missing_groups), 'missing_group_n': missing_groups, 'group_order': 'Observed categorical level order' if categorical else 'Lexicographic observed labels', 'groups': [{'label': label, 'sampled_n': int(mask.sum())} for label, mask in zip(labels, masks)], 'features': settings['features'], 'matrix_dtype': str(getattr(matrix, 'dtype', 'dataframe column dtypes')), 'cells': cells, 'sample_sha256': sample_hash.hexdigest(), 'sampling': 'Uniform without replacement, fixed seed, sorted observation indices; group frequencies describe the preview sample only', 'aggregation': 'Selected values are converted to float64. Color is finite-value sample mean; marker area is 400 * fraction strictly above threshold among finite values. Zero fraction leaves no dot. Missing groups are excluded; no-finite cells are gray crosses. No scaling or transform applied.', 'evidence_scope': 'Exploratory grouped sample only; no differential expression, biological-replicate inference, full-matrix hash or normalization/log history is implied'}
    coords = None
    valid = np.ones(indices.size, dtype=bool)
    if settings['plot'] == 'embedding':
        if settings['embedding'] not in obj.obsm:
            raise KeyError('Embedding does not exist; this explorer never computes reductions implicitly')
        matrix = obj.obsm[settings['embedding']]
        if not hasattr(matrix, 'shape') or len(matrix.shape) != 2 or matrix.shape[0] != total or matrix.shape[1] > 1024:
            raise ValueError('Use an aligned two-dimensional embedding with at most 1024 columns')
        if max(settings['axes']) >= matrix.shape[1]:
            raise ValueError('Requested embedding dimension does not exist')
        coords = np.column_stack([column(matrix, axis) for axis in settings['axes']])
        valid = np.isfinite(coords).all(axis=1)
        if not valid.any():
            raise ValueError('No finite embedding coordinates in this sample')
    values = None
    numeric = False
    value_label = 'observations'
    if settings['color'] == 'obs':
        if settings['field'] not in obj.obs:
            raise KeyError('Requested obs field does not exist')
        series = obj.obs[settings['field']].iloc[indices]
        if isinstance(series, pd.DataFrame):
            raise ValueError('Requested obs field is duplicated; use unique metadata column names')
        numeric = pd.api.types.is_numeric_dtype(series.dtype) and not pd.api.types.is_bool_dtype(series.dtype)
        if numeric:
            values = series.to_numpy(dtype=float, na_value=np.nan).copy()
        else:
            values = [None if pd.isna(value) else str(value) for value in series.tolist()]
            if any(value is not None and len(value) > 500 for value in values):
                raise ValueError('Category labels exceed 500 characters; prepare explicit bounded labels first')
        value_label = 'obs: ' + settings['field']
    elif settings['color'] == 'feature':
        selected = obj.raw if settings['source'] == 'raw' else obj
        if selected is None:
            raise ValueError('Requested raw matrix is absent')
        if not selected.var_names.is_unique:
            raise ValueError('Feature identifiers are not unique; resolve the requested feature explicitly')
        if settings['field'] not in selected.var_names:
            raise KeyError('Feature identifier does not exist in the selected matrix source')
        feature = int(selected.var_names.get_loc(settings['field']))
        if settings['source'] == 'layer':
            if settings.get('layer') not in obj.layers:
                raise KeyError('Requested expression layer is absent')
            matrix = obj.layers[settings['layer']]
        else:
            matrix = selected.X
        if matrix is None:
            raise ValueError('Selected expression matrix is absent')
        values = column(matrix, feature)
        numeric = True
        value_label = settings['field'] + ' [' + (('layer:' + settings['layer']) if settings['source'] == 'layer' else settings['source']) + ']'
    plotted_values = np.asarray(values, dtype=float)[valid] if numeric else ([value for value, keep in zip(values, valid) if keep] if values is not None else None)
    labels = sorted(set(value for value in (plotted_values or []) if value is not None)) if not numeric else []
    if len(labels) > 20:
        raise ValueError('Sample has more than 20 categories; choose a coarser field or prepare explicit plotting code')
    figure, ax = plt.subplots(figsize=(7, 5))
    missing = 0
    if settings['plot'] == 'embedding':
        points = coords[valid]
        if numeric:
            finite = np.isfinite(plotted_values)
            if finite.any():
                scatter = ax.scatter(points[finite,0], points[finite,1], c=plotted_values[finite], cmap='viridis', s=8, alpha=0.75, linewidths=0)
                figure.colorbar(scatter, ax=ax, label=value_label)
            missing = int((~finite).sum())
            if missing:
                ax.scatter(points[~finite,0], points[~finite,1], c='#b8b8b8', s=8, label='Missing / non-finite color', linewidths=0)
                ax.legend(loc='best', fontsize=8)
        elif plotted_values is not None:
            palette = plt.get_cmap('tab20')
            for index, label in enumerate(labels):
                mask = np.asarray([value == label for value in plotted_values])
                ax.scatter(points[mask,0], points[mask,1], color=palette(index), s=8, alpha=0.75, linewidths=0, label=(label if len(label) < 80 else label[:70] + '… [' + str(index+1) + ']'))
            mask = np.asarray([value is None for value in plotted_values]); missing = int(mask.sum())
            if missing:
                ax.scatter(points[mask,0], points[mask,1], color='#b8b8b8', s=8, label='[missing values]', linewidths=0)
            ax.legend(title=value_label, loc='best', fontsize=8)
        else:
            ax.scatter(points[:,0], points[:,1], c='#3e7467', s=8, alpha=0.75, linewidths=0)
        ax.set_xlabel(settings['embedding'] + ' [' + str(settings['axes'][0]+1) + ']')
        ax.set_ylabel(settings['embedding'] + ' [' + str(settings['axes'][1]+1) + ']')
    elif numeric:
        finite = np.isfinite(plotted_values); missing = int((~finite).sum())
        if not finite.any():
            plt.close(figure)
            raise ValueError('No finite values for this distribution')
        ax.hist(plotted_values[finite], bins=30, color='#3e7467', edgecolor='white')
        ax.set_xlabel(value_label); ax.set_ylabel('Sampled observations (not biological replicates)')
    else:
        counts = [sum(value == label for value in plotted_values) for label in labels]
        missing = sum(value is None for value in plotted_values)
        display_labels = [label if len(label) < 80 else label[:70] + '… [' + str(index+1) + ']' for index, label in enumerate(labels)]
        if missing:
            display_labels.append('[missing values]'); counts.append(missing)
        ax.bar(range(len(counts)), counts, color='#3e7467')
        ax.set_xticks(range(len(counts)), display_labels, rotation=45, ha='right')
        ax.set_xlabel(value_label); ax.set_ylabel('Sampled observations (not biological replicates)')
    rendered_indices = indices[valid] if settings['plot'] == 'embedding' or not numeric else indices[np.isfinite(np.asarray(values, dtype=float))]
    ax.set_title(settings['variable'] + ' · ' + settings['plot'] + ' · ' + str(int(rendered_indices.size)) + '/' + str(total) + ' observations')
    figure.tight_layout()
    names_hash = hashlib.sha256()
    for name in names:
        encoded = name.encode('utf-8'); names_hash.update(len(encoded).to_bytes(4, 'big')); names_hash.update(encoded)
    category_map = {label: index for index, label in enumerate(labels)}
    payload = {'indices': indices.tolist(), 'visible_indices': rendered_indices.tolist(), 'obs_names_sha256': names_hash.hexdigest(), 'coordinates': coords[valid].tolist() if coords is not None else None, 'categories': labels, 'values': ([float(value) if np.isfinite(value) else None for value in plotted_values] if numeric else ([category_map[value] if value is not None else None for value in plotted_values] if plotted_values is not None else None))}
    return {'schema': 'omicos.anndata-plot/1', 'settings': settings, 'n_obs_total': total, 'sampled_n': int(indices.size), 'plotted_n': int(rendered_indices.size), 'invalid_coordinates': int((~valid).sum()), 'missing_color_values': missing, 'sample_sha256': hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest(), 'sampling': 'Uniform without replacement, fixed seed, sorted observation indices; category frequencies describe the preview sample only', 'evidence_scope': 'Exploratory existing data/embedding preview; full input matrix hash, transform history, clustering validity and independent biological replication are not inferred'}
print('OMICOS_ANNDATA_PLOT=' + __import__('json').dumps(_omicos_plot_ann_data(), ensure_ascii=True))
del _omicos_plot_ann_data`
}
