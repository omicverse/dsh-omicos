# ADR 0019: Color-declared PNG publication without sample reduction

Status: implemented for static PNG iCCP, sRGB and supported gAMA/cHRM declarations.

The PDF worker independently reconstructs all supported PNG sample types, five
filters and Adam7 passes. RGB/grayscale 8/16-bit values and alpha remain exact;
1/2/4-bit gray expands to exactly representable 8-bit levels, and palette indices
expand to the original 8-bit RGB entries with tRNS alpha. This avoids the previous
library conversion of grayscale to RGB, which cannot correctly use a one-channel
ICC profile. Source PNG attachments still contain the exact original bytes.
No scientific code, subprocess, color download or Host color library runs.

## Color interpretation

- iCCP: retain the entire decompressed original profile in a PDF ICCBased image
  space with N=1 or N=3 matching the PNG. Record profile name/SHA/size/version and
  rendering intent. Alpha uses an independent DeviceGray soft mask; gamma/ICC is
  never applied to alpha. Original profile bytes are not rewritten or converted.
- sRGB: use a checksum-pinned, locally generated Little CMS 2.16 sRGB ICC profile,
  including its piecewise transfer curve rather than a gamma-2.2 approximation.
  The profile's own notice is `No copyright, use freely`; provenance/generation
  is documented beside the 588-byte asset. Gray code values are replicated into
  RGB at the same precision; alpha stays unchanged. PNG intent maps to PDF intent.
- gAMA: a reciprocal decoding exponent in the supported 0.1–10 range maps to
  CalGray or CalRGB. cHRM coordinates derive the white point and RGB matrix by
  solving the primary luminances. When gAMA lacks cHRM, explicitly assume sRGB
  primaries/D65; both the confirmation UI and per-source provenance disclose that
  assumption. No claim is made to know missing source primaries.
- ICC/sRGB take precedence over fallback gAMA/cHRM, whose presence is recorded.
  Simultaneous iCCP+sRGB, duplicate declarations and invalid color-chunk order
  reject. cHRM alone lacks a transfer curve and rejects; no gamma is invented.
- No declaration: DeviceGray/DeviceRGB with explicit unmanaged provenance.

## Bounds and limitations

Profile inflation is bounded to 4 MB; complete compressed consumption, declared
profile length, acsp/version/class/PCS/channel header fields, intent, bounded tag
counts and tag ranges are checked. Exact shared tags are permitted; partial
range overlaps reject. These are structural checks, not ICC certification, an
exhaustive validation of every tag payload, printer proofing, PDF/A or PDF/X.
Final appearance depends on the PDF viewer/output device. HDR/cICP/mDCV/cLLI,
nonidentity EXIF orientation/unknown presentation extensions and animation remain unsupported. EXIF main-image TIFF orientation must be absent or 1; other metadata is retained in the exact original attachment without following unrelated EXIF pointers. Suggested bKGD is validated but the saved assembly page stays white, with that override recorded. Actual macOS R PNGs with platform ICC and EXIF have a real export/render test.

PNG decoding uses exact expected pass sizes and bounded inflate, with a 96 MB
unpacked input/output sample budget per image, including any gray-to-RGB expansion.
This is a per-buffer/data bound, not a total process RSS guarantee. Existing
assembly input/count/pixel limits and cancellable, deadline-limited workers apply.
Nonrendering compressed text is not expanded. Original attachment metadata and
execution code/paths are not automatically redacted.

Tests independently construct low-depth grayscale/palette, 8-bit and 16-bit PNGs,
all filter/Adam7 combinations and transparency. They inspect actual decoded PDF
sample/alpha streams, ICC bytes/N/intent and calibration parameters, plus rejection
of malformed/oversized/contradictory declarations. Independent Poppler rendering
of a gamma-2 midpoint produces RGB 137/137/137, consistent with the expected sRGB
output of the declared linear-light value; ICC/gray/Chinese-font renders have no
warnings locally. The clean packed install exercises the bundled sRGB profile.
All 259 tests across 45 files passed under actual Node 22.13.1; full standalone browser regression, typechecks/build and clean packed sRGB export also passed. Remote CI has these checks configured; a local check is not a claim of remote CI.

References: [W3C PNG 3](https://www.w3.org/TR/png-3/),
[Adobe PDF 32000-1:2008, §8.6.5](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf),
[PDF Association color processing](https://pdfa.org/download-area/cheat-sheets/Color.pdf),
[Little CMS generated profile implementation](https://github.com/mm2/Little-CMS/blob/lcms2.16/src/cmsvirt.c).
