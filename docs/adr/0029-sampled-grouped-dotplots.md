# 0029 — Approved grouped multi-feature AnnData dotplots

The scientific workbench needs grouped multi-feature exploration alongside the
existing embedding and single-field distributions. A new dotplot mode reuses the
same approved project Python execution, exact request replay semantics, lost
kernel-generation fences and persisted figure receipts. It introduces no new
Agent loop, package installation, implicit analysis or separate data copy.

A request explicitly selects 1–20 unique feature identifiers, an existing
categorical/string/boolean obs grouping field, X/layer/raw source, a finite
threshold in that matrix's units and the existing uniform sample/seed (at most
10,000 observations). Continuous numeric grouping is rejected unless explicitly
represented as categorical data. Observed categorical groups retain their declared level order (using sampled
category codes); other labels sort lexicographically. The resolved order is
recorded and included in the sample hash. Sample groups are limited to 20, labels and
feature names are bounded, and duplicate/ambiguous labels are rejected rather
than merged. Missing groups are excluded and counted. Selected sparse/backed
columns are read sequentially through the existing sampled 128-row column helper;
the full expression matrix is never explicitly densified by the generated code.
Supported backends remain NumPy/pandas, scipy sparse and supported HDF5/AnnData
backed arrays; unsupported lazy/device backends need explicit plotting code.

For each sampled group/feature, color is the finite-value float64 sample mean.
Dot area in points squared is 400 times the fraction strictly greater than the
threshold among finite observations. This denominator includes finite zeros and
negatives and excludes NaN/infinity; it is not automatically a fraction of
biologically expressing cells. Zero fraction produces no dot, with an explicit
legend entry. A cell with no finite values is a gray cross and retains null mean/
fraction in its receipt. An entirely non-finite grouped sample is rejected.
Complex matrices require an explicit real/imaginary decision. Means that overflow
are rejected. No normalization, scaling, log, reduction, clustering, differential
expression or biological-replicate inference is performed.

The receipt retains normalized settings and source, dtype, feature order, group
sample sizes, missing-group count and every cell's finite/nonfinite/above-threshold
counts, mean and fraction. A length-framed SHA-256 covers normalized settings,
sorted sampled indices, observation-name hash, grouping and selected finite-value
column representations. Nonfinite values use null in that representation. It
identifies this declared sampled preview, not original raw matrix bytes, full
input provenance or scientific validity. Existing execution code/environment/
artifact hashes retain the rendering provenance. Labels may be visually shortened
with indexed suffixes; complete identifiers remain in the receipt.

The workbench provides multiline exact IDs, grouping, threshold and source
controls and shows the generated code before explicit approval. Plot execution
rechecks the current object; an inspection receipt is not an immutable object
snapshot. The Harness tool documents the same bounded settings/semantics and keeps
its existing human-approval requirement. PNG/PDF/SVG outputs remain available for
Figure Studio curation through their actual execution receipt.

Real Python tests verify exact sparse means/fractions, equality-at-threshold,
missing groups and all-nonfinite cells, repeat hashes, independent X/layer/raw
sources, numeric categorical support, ambiguous/continuous grouping and complex
rejection, and unchanged scientific objects. Backed tests plot selected columns
and preserve the actual H5AD file hash; oversized sampled groups reject before
figure creation. HTTP tests retain approval, replay and cold lost-generation
fences. Standalone Chrome selects a layer/threshold, verifies real receipt values
and loads the generated PNG. Other chart families, differential analysis and
publication assessment remain separate capabilities.
