# Bundled publication font

`SourceSans3-Bold.ttf` is the unmodified Adobe Source Sans 3 release font from
commit `87b37a2daaed80fcb8e8ccb0085c4d72ddade12e` of
https://github.com/adobe-fonts/source-sans (path `TTF/SourceSans3-Bold.ttf`).

The font is separately licensed under SIL OFL 1.1, not relicensed as GPL.
`SourceSans3-LICENSE.md` is the original upstream copyright/OFL notice.
Checksums/source attribution are in `manifest.json`; runtime verifies the font
and license before use. No bundled font file has been renamed or modified.

PDF uses an embedded subset when permitted. A user-supplied static project
font is separate and requires an explicit checksum and embedding-license
claim. CFF/OTF embeds in full with the correct OpenType stream declaration;
no-subsetting flags also retain full fonts. Glyph coverage is checked and
missing glyphs reject. These technical checks are not independent legal
verification of a user-supplied font license.

Noto Sans CJK used by optional/CI rendering fixtures is not distributed in the
package. Tests fetch the pinned public source in CI, verify its SHA-256, and
retain its owner-declared OFL attribution in generated test PDFs.
