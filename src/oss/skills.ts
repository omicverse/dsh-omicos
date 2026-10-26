/** Original public checklists, intentionally independent of paid/private catalogs. */
export const SCIENTIFIC_SKILLS = {
  'anndata-audit': {
    title: 'AnnData state and provenance audit',
    description: 'Inspect data identity and transform state before analysis.',
    body: `Record input path/accession, organism, assay, reference and sample/donor design. Inspect shape, X dtype/sparsity, obs/var schema, layers, raw, obsm and uns keys without densifying X. A log1p marker is a clue, not proof of preprocessing; inspect provenance and ask when ambiguous. Never repeat normalization, scaling, batch correction or log transforms blindly. Preserve original count data and document which layer is used by each method. Check unique feature/cell identifiers and metadata alignment. Do not infer biological replication from cell count. Inspect dataset licenses and sensitive metadata before any network upload.`,
  },
  'single-cell-qc': {
    title: 'Single-cell quality control and preprocessing',
    description: 'Design cohort-aware QC and preserve raw counts.',
    body: `First use anndata-audit. Confirm organism-specific mitochondrial features and assay-specific QC conventions. Summarize library size, detected genes and mitochondrial fraction by sample; do not apply arbitrary universal thresholds. Preserve a count layer before transformations and make filtering decisions inspectable. Account for ambient RNA/doublets when relevant using validated compatible methods. Track cells/features before and after each filter. Do not batch-correct away the biological contrast. Record random seeds, software versions, parameters and method references. Large recomputation requires approval and resource estimates.`,
  },
  'differential-expression': {
    title: 'Replicate-aware differential expression',
    description: 'Avoid pseudoreplication and separate exploratory markers from confirmatory tests.',
    body: `Confirm biological question, independent donors/samples, contrast, cell populations, covariates and pairing. Cell-level marker ranking is exploratory and does not turn cells into independent biological replicates. Where appropriate, aggregate raw counts by independent sample and cell type, check design rank and use a validated count model. Do not invent replication if absent; label limitations. Specify filtering, normalization, model, contrast and multiple-testing correction. Report effect sizes, uncertainty and adjusted significance with sample counts. Keep source tables and provenance, not only a plot. Avoid choosing the model after inspecting desired outcomes.`,
  },
  'scientific-figures': {
    title: 'Reproducible scientific figures',
    description: 'Produce inspectable, labeled figures tied to real data.',
    body: `Tie every panel to a dataset, transformation and output table. Label axes, units, groups and independent sample counts; explain color scales and legends. Preserve data-derived uncertainty and identify exploratory analyses. Do not generate scientific measurements with an image model or fabricate significance. Save a raster preview and a vector export when appropriate, with explicit dimensions and readable type. Check clipping, empty groups, missing values and color accessibility. Retain plotting code, package versions and source data hashes. A figure artifact hash proves file identity, not scientific validity.`,
  },
} as const
export function scientificSkill(id?: string): unknown {
  if (!id) return Object.entries(SCIENTIFIC_SKILLS).map(([id, skill]) => ({ id, title: skill.title, description: skill.description }))
  if (!Object.prototype.hasOwnProperty.call(SCIENTIFIC_SKILLS, id)) throw new Error('Unknown public scientific skill')
  return { id, ...SCIENTIFIC_SKILLS[id as keyof typeof SCIENTIFIC_SKILLS] }
}
