# Font-aware scientific assembly PDF

Goal: export the same source-pinned panel geometry to a portable single-page PDF with embedded label fonts, explicit physical-size mapping, original PNG attachments and a provenance attachment. No plot/kernel execution, browser printing, cloud upload or implicit font substitution.

Keep export parameters separate from the saved assembly review: owner-confirmed POST selects dpi (72–1200) and either a bundled unmodified OFL font or a contained project-relative static TTF/OTF with expected SHA-256 and an explicit embedding-license declaration. The PDF records these current export choices; prior human assembly review does not automatically assess a new format/font/physical size. A missing glyph or a label exceeding its panel rejects instead of silently replacing/clipping. DPI maps saved layout pixels to PDF points and never increases original image resolution; record actual panel effective resolution.

Bundle an unmodified public Source Sans 3 Bold font with its original OFL notice, pinned upstream commit and checksum. Do not download fonts at runtime. A user can supply a suitable licensed CJK font via normal project file import; resolve only approved nonprivate regular project files and recheck hashes. Validate static sfnt directory bounds and embedding restrictions; reject unsupported collections, variable/bitmap-only/restricted fonts. Honor no-subsetting flags. Record license declarations as owner claims, not automatic legal verification.

Reuse assembly source verification and pixel/byte limits. Render in a trusted Node worker thread with scrubbed environment, bounded concurrent work, a deadline, abort/disposal termination and a V8 heap limit (not an OS sandbox/absolute native-memory cap). Start with supported static <=8-bit PNGs in unmanaged DeviceRGB: reject animated, 16-bit or color-profile/gamma-dependent PNGs rather than silently reduce scientific precision/color behavior. Original PNG files are attached byte-for-byte as evidence; PDF drawing uses lossless decoded pixel samples and alpha, not unchanged PNG container streams. Color-managed/16-bit/vector/JPEG publication work remains explicit follow-on scope.

Verify real PDF parser/page geometry, embedded fonts, missing-glyph rejection, exact original file attachment hashes, current/frozen provenance, checksum/path/font policy, cancellation/worker cleanup, Chinese text extraction/raster rendering with a real public CJK font, actual Python figures and browser download plus existing regressions. Broader final publication/journal claims remain unproven until those formats/policies are implemented and tested.

Follow-up implemented: direct exact 16-bit grayscale/RGB/alpha PDF image streams, bounded independent PNG decoding with all filters/Adam7, literal PDF sample tests. Color management remains pending; original starting scope above describes the initial checkpoint.

Color follow-up implemented in ADR 0019: ICC/sRGB/gAMA/cHRM PDF spaces, independent all-depth PNG decoding, declared missing-primary assumptions and output-level sample/profile tests. HDR, animation, broader proofing and journal profiles remain pending.

Attachment follow-up implemented in ADR 0020: explicit provenance/page-only output, strict unknown-field rejection, response policy acknowledgement, no source attachment/document metadata in page-only mode, unchanged rendering checks. Reusable named profiles and broader content redaction remain pending.

Reusable project preferences implemented in ADR 0021: immutable DPI/font/attachment versions, exact historical selection, CAS/archive/restore, stable retry receipts, explicit owner save and bound saved-revision export. Physical page/journal presets and broader anonymization remain pending.
