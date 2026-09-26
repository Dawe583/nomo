# iOS cache retention and device removal

Audit row 49, matrix row P06.05. The policy is stated here, and the code that
enforces it is named at each clause, because a policy that lives only in a
comment is not a policy anybody can check.

## The policy

1. **No response the executor sends is stored on the device.**
   `CompanionCachePolicy.apply(to:)` empties and then detaches the URL cache,
   the cookie store and the URL credential store, and forces
   `.reloadIgnoringLocalCacheData`. `URLSessionTransport` calls it for every
   session it builds, so no call site can forget. `CompanionCachePolicy.purgeSharedCaches()`
   empties the process-wide `URLCache.shared` and `HTTPCookieStorage.shared`,
   which a session built elsewhere in the app could still be writing to.

2. **A transcript is in memory, for this process only, and is never
   authoritative.** `TranscriptCache` is an actor with no persistence hook and
   no `Codable` container, so an entry has no route to disk. Every
   `CachedTranscriptEntry` carries `authority == .nonAuthoritative` as a stored
   constant rather than a parameter, so neither a call site nor a decoder can
   produce an entry that claims to be current. The cache exposes a list and
   nothing else: there is deliberately no method that reports whether an
   operation is running, pending, or reversible. Retention is bounded at 200
   entries, oldest first out.

3. **No mutation is computed from a cache.** `ForwardMutationDraft` is
   constructed only from a `TurnSequence`, and `TurnSequence` is produced only
   by `next()`. Nothing the cache holds carries one, so a relaunch starts at
   turn one and cannot re-issue an idempotency key the executor already
   honoured.

4. **The device credential is in the Keychain and nowhere else.**
   `DeviceCredentialStore` has exactly one implementation,
   `KeychainDeviceCredentialStore`, over `SecureKeychainStore`. There is no
   `UserDefaults`, plist, file, or log path. `DeviceCredential` supplies both
   `description` and `debugDescription`, so interpolation, `print`, a crash
   reporter and the debugger's mirror all see the identity without the token.

5. **Removing this device leaves no credential behind.**
   `DeviceRemovalService.removeStoredDevice()` revokes on the executor first,
   deletes the Keychain credential second, and empties every cache third. The
   local half happens even when the executor is unreachable, because a
   credential that outlives the removal is the one outcome the path exists to
   prevent. The receipt says which of the two happened: `AppModel.RemovalOutcome`
   distinguishes `.removed`, `.removedLocallyOnly`, and `.failed`, and the
   Settings screen never collapses the last two into "done".

## Where the operator reads it

`CompanionCachePolicy.operatorSummary` is the sentence the Settings screen
shows, in both English and Czech (`AppCopy.cachePolicyDetail`). It is the same
three clauses as above, and a test asserts that it still contains them, so the
wording cannot drift away from the code.

## What this does not claim

A simulator is not a device. The Keychain read-back, the cache emptying and the
removal receipts are proven by XCTest on a simulator and by `swift test` on the
host. A paired-device round trip against the live routes on hardware is audit
item 48 and is out of scope here.
