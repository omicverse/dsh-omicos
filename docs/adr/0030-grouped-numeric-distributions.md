# 0030 — Approved grouped numeric AnnData distributions

Boxplot and violin modes extend the same owner/Host-approved AnnData preview path.
They select one numeric obs field or exact expression feature, a categorical
obs grouping field, X/layer/raw for feature values, sample bound and fixed seed.
The existing generation fence, operation replay and real receipt/artifact storage
apply. Matrix-source knobs are not used for obs values; a separate value_source
receipt names the actual axis-data origin explicitly.

Grouped plots now share one categorical reader with dotplots: sampled missing
groups are excluded/counted, ambiguous labels and continuous numeric grouping are
rejected, observed categorical levels retain their declared order, and other
labels sort lexicographically. Sparse/backed expression reads still use sampled
bounded columns. Numeric obs nullable missing values become NaN in a local
float64 copy. Complex obs/matrices require explicit handling instead of silently
dropping an imaginary component. No original X/layer/raw/obs or embedding data is
transformed or rewritten.

For each group, the receipt preserves sampled/finite/nonfinite counts, min/max,
mean, quartiles, median, whisker endpoints, outlier count and actual rendering mode.
Box statistics use matplotlib.cbook.boxplot_stats with linear quantiles,
whis=1.5, bootstrap=None and autorange=False. Rendering uses those same precomputed
statistics via bxp, including every outlier. Matplotlib clamps a whisker to its
interpolated quartile edge if no candidate extends beyond that edge; the native
fixture explicitly covers this convention rather than inventing different
endpoints. Empty-finite groups have null summaries and a clearly labeled empty
position. An entirely non-finite grouped preview is rejected.

Violin density uses GaussianKDE with Scott bandwidth and 100 coordinates.
Precomputed violin_stats feed the renderer, with medians/extrema visible and
means hidden. Each body is scaled to its own peak at a fixed width; widths do not
encode group sizes or comparable integrated probability mass. Single-value and
constant groups receive a line, never a fabricated KDE. Numeric summaries and
density values are checked for finiteness before figure creation; unstable KDE
requests fail with an explicit numeric-handling/boxplot alternative. Library
numeric precision and sampled observations remain part of the declared scope.
No hypothesis tests, confidence/bootstrap intervals, transformations or biological
replicate inference are added.

The sample hash covers normalized settings, sampled positions, observation-name
hash, grouping/order and finite-value representations. It is not a full-matrix
hash or independent scientific validation. Actual code/environment and PNG/PDF/SVG
hashes remain in the execution receipt for Figure Studio review. The UI explains
the estimator/scale choices, displays finite sample sizes on the axis and requires
explicit approval after showing the generated code.

Real Python fixtures verify interpolated quartiles/outliers, Matplotlib whisker
edge behavior, means and X/layer/raw differences, numeric obs, constant/single/
missing groups, nonnumeric/complex rejection, repeated hashes, object preservation
and actual read-only H5AD file hashes. Existing dotplot regressions caught and
fixed a removed local-variable reference during grouping extraction. HTTP/Host
checks retain approval and lost-generation fences. Standalone Chrome creates a
separate real AnnData object through the approved console, checks numeric obs box
quartiles and categorical order, then verifies actual layer violin density and a
constant marker; both rendered screenshots are visually inspected.
