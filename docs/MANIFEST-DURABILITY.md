# Snapshot manifest persistence

The legacy connector manifest writer serializes in-process writes and exclusively
creates a lock file to refuse competing processes. Stale locks require operator
inspection. Invalid existing entries are refused before replacement.

Each replacement uses an exclusively created mode-0600 temporary file in the
same directory, writes and flushes its writable handle, closes it, then renames
it over the manifest. Failures before rename leave the previous manifest intact;
temporary files are cleaned up and the error propagates. A retry reads the
current manifest rather than a cached copy.

Unix additionally flushes the containing directory. A directory-flush failure
after rename is reported, although the new manifest may already be visible;
callers must inspect state before retrying an ambiguous failure.

Windows flushes file contents but Node cannot flush a directory handle there.
Successful return therefore does not guarantee the replacement directory entry
survives power loss. No fsync error is silently ignored. Filesystem and hardware
durability guarantees still apply; this is not a transactional remote store.

The same Windows directory-flush limitation applies to Workbench encrypted
snapshots and the runtime journal/vault. Workbench snapshots flush a writable
temporary file before replacement; the reserved vault uses SQLite's committed
transaction. Unix directory flushes remain mandatory and propagate failures.
On Windows, keep these files in a private user directory governed by filesystem
ACLs; POSIX mode bits do not establish equivalent access control.
