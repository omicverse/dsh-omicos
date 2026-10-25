# ADR 0020: Explicit PDF attachment policy and page-only output

Status: implemented; reusable named publication profiles remain separate work.

The export profile accepts `attachments: 'provenance' | 'none'`. Omitting it
retains the existing provenance behavior for API compatibility. The workbench
always submits its selected policy and resets confirmation/output digest when
that selection changes. A prior assembly review never grants export consent.

Provenance mode attaches the exact original PNG containers, execution/source
manifest and font-license declaration; it also retains assembly title/caption
and export date metadata. This mode is not automatically redacted.

Page-only mode embeds the same scientific samples, alpha, checked font, color
interpretation, layout and labels, but has no EmbeddedFiles/Names, provenance
JSON, original PNG container or font-declaration attachment. It does not create
Info/XMP document metadata or copy assembly title/caption/timestamps. The Host
sends only layout and the minimal export/font choices to the rendering worker,
not the original source-record manifest or title/caption. Source bytes and font
permission/identity checks still apply; this is not a way to bypass consent.

The user-facing boundary is explicit: visible text/pixels and internal embedded
font/ICC data remain. This is not automatic anonymization, a secret scanner,
optical redaction or a promise that arbitrary font/profile bytes contain no
personal metadata. Saved project/source records are unchanged. Source-mode
provenance remains available through a separately confirmed export.

## Fail closed across mismatched versions

Unknown profile/font keys and unknown attachment values reject before source
capture. A misspelled privacy option cannot silently select source attachments.
HTTP responses declare `x-omicos-pdf-attachments` in addition to the actual output
SHA-256. Before reading/downloading the response body, the client requires the
acknowledged policy to equal its request. An absent/mismatched acknowledgement
cancels that response body and fails; it never retries or falls back to a less
private mode. This also prevents a refreshed client from downloading an older
Host response that ignored the new option. Only the existing exact pre-dispatch
CSRF rejection is eligible for one stable-request retry.

Bundled Source Sans 3 remains OFL licensed with original notice distributed in
the package. Page-only document embedding does not require a license attachment
under the official [OFL embedding FAQ 1.10–1.13](https://openfontlicense.org/ofl-faq/).
Custom font embedding still requires the owner's declared permission and OS/2
checks; that declaration is not independent legal verification. Full-font CFF
correctness remains subject to the existing checked embedding path.

Verification inspects actual PDF catalogs, Info/XMP absence, decoded indirect
streams and source/code/path/font-declaration sentinels; it checks unchanged
samples, page size and embedded fonts. Real owner/CSRF HTTP tests cover both
modes and the acknowledgement. Client tests cover missing/mismatched policy and
actual digest verification. Browser coverage switches modes, checks fresh consent
and absence of attachments/Info in the downloaded page-only document. Independent
Poppler output for page-only and provenance fixtures is compared pixel-for-pixel.
These checks do not establish automatic content anonymization or remote CI status.

Local verification checkpoint: all 263 tests across 45 files passed on actual Node 22.13.1, typechecks/build and clean packed installation passed, and independent page raster outputs were identical without Poppler warnings. Full standalone browser mode-switch/download checks passed, including cleared consent, absent Names/Info and SHA-256, without page errors; remote CI execution is not implied.
