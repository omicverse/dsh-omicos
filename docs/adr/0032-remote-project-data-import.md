# 0032 — Durable owner-approved remote dataset imports

Remote data import is a project-owned HTTP transfer, not a scientific execution or
cloud upload. The workbench owner approves an immutable source request, optional
independent expected length/SHA-256 and project destination. Agent integration
exposes only redacted receipt discovery. Reads, tool calls and Host startup do not
start/resume network work. No private Core implementation is used.

Production accepts credential-free HTTPS URLs, 1–8 explicit exact origins and at
most five followed redirects. URL query parameters may contain signed source
access and are stored only in private owner metadata; ordinary UI/summaries and
Agent descriptions omit queries. No cloud authorization, cookies or arbitrary
custom headers are forwarded. Node fetch requests identity encoding, rejects
encoded representations and enforces 10 GiB/optional exact length while reading.
Independent SHA-256 is optional; its absence is explicitly labelled rather than
conflated with verification against a publisher's checksum. Native tests alone
can opt into loopback HTTP; this is not an exposed runtime configuration.

Private staging commits 4 MiB chunk hashes, byte progress and fsynced bytes with a
WAL/FULL ledger. Chunk rows are separate from bounded receipt JSON. Resume first
checks all committed local chunks and truncates only an uncommitted tail. Range
requests use the original strong ETag in If-Range and require exact 206 range,
total, end and ETag. Unknown-length/no-strong-ETag sources may complete normally,
but interrupted partial sources without the necessary representation pin cannot
continue; the owner must cancel and create a new request. Expired signed URLs are
not silently renewed or replaced. Authenticated connectors remain separate.

EOF is its own durable fact. Reaching a declared total is not evidence of EOF:
an oversized/chopped stream must not later publish a prefix as a complete file.
The final partial chunk and EOF/hash marker commit together; full-chunk streams
record EOF separately only after complete body consumption and length checks.
Expected-checksum mismatches never publish. Complete transfer staging can be
reverified for publication without contacting the source again.

Publication reuses DataUploads rather than creating another weaker file writer.
An internal fixed-path adopter accepts only downloads/<id>.part and the matching
remote-<id> operation, pins the full chunk manifest/hash, links/replaces private
upload staging and delegates to the existing final verifier/no-overwrite commit.
The initial destination directory's device/inode must still match. Another file
or local upload can claim the target during a download; publication stops rather
than overwriting it. Both staging areas must support same-filesystem hardlinks.

The adoption marker is persisted before replacing staging. Recovery identifies a
shared inode and retains its full received length instead of truncating it to the
old zero offset, which would also destroy the recoverable download source. A
crash before replacement retains the earlier upload offset. Recovery only
reconciles metadata; publication still requires an explicit continuation. Exact
indexed operation lookup reconciles a prior committed publisher receipt even
when it is older than the recent discovery page. Once committed, receipt hashes
describe import-time bytes; later scientific edits are not automatically certified.

At most four unfinished remote files/two active transfers exist per project.
Project ownership remains exclusive across Hosts. Pausing aborts/waits for the
actual network task and retains committed staging; publication has a separate
non-pausable verification/commit boundary. Canceling reconciles publisher state
and never deletes a committed project file. Host disposal stops remote transfers
before disposing upload ledgers; startup marks interrupted operations paused and
performs no HTTP request or new publication. Literal source descriptors are
immutable and exact operation retries cannot initiate a fresh download.

Limitations: no custom credentials, signed-URL refresh, directory synchronization,
remote archive extraction, automatic load/analysis or source-signature PKI. The
browser regression uses a real temporary HTTPS CA trusted by the child Host,
not disabled TLS verification. Native tests exercise the real byte/range paths;
they do not establish every external dataset provider or Windows filesystem.
