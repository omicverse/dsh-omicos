# 0003 — Scientific worker lifetime belongs to the Host

A silent Python/R computation may outlive a forcibly terminated parent. Reopening a project while such an orphan still writes files would undermine checkpoint recovery.

On POSIX a small bundled Node supervisor leads a detached process group containing the scientific interpreter. An additional inherited Host-lifetime socket (fd 4) belongs only to the supervisor and Host; the interpreter receives only the existing execution wire (fd 3). Host death closes the lifetime socket and the responsive supervisor kills the process group. Host cancellation/shutdown likewise signals the group, so escalation can terminate native computations that do not yield to a language-level watchdog. This adds one lightweight Node process per kernel but does not require a new scientific dependency.

The wrapper does not parse execution messages or model credentials. Python/R preserve their existing wire, environment projection and interpreter fingerprint. The ordinary runtime waits for process-family termination before releasing its ownership lock. Trusted user code can deliberately create a separate session/process group, and external jobs or writes may have partial side effects; this is lifecycle management, not a sandbox or exactly-once I/O guarantee. Windows lifetime behavior remains unverified.

Verification includes real Python/R cancellation plus a compiled standalone browser integration that starts a silent delayed Python write, kills the Host with SIGKILL, and verifies the worker exits before completing that side effect.
