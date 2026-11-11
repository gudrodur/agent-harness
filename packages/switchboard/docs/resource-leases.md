# Resource leases

An exclusive, queued, expiring hold on something several sessions share: a test device, a hardware port, a single-user account. `lib/resource-leases.mjs` keeps it in the same `state.db` as the mailbox.

A seat role is an address, so the latest claim wins. A lease is the opposite: while one session holds a resource, every other session is refused and may wait in a first-come-first-served line.

## Lifecycle

| Call | Effect |
| --- | --- |
| `acquire({resource, sessionId, purpose, scope, ttlMs})` | Grants when the resource is free and the caller is first in line. Otherwise it joins the line and returns its `position`. A holder calling again renews. |
| `authorize({resource, sessionId})` | The gate a hook or wrapper calls before acting. Allowed for the holder, whose heartbeat is refreshed. When the resource is free and nobody waits, it grants an **implicit** lease with a short TTL, so a session working alone never meets the lease. Refused with `reason` `held`, `queued` or `human`. A refusal never joins the line. |
| `heartbeat` | Keeps the holder's lease alive. |
| `release({sessionId})` / `release({human: true})` | A session releases only its own lease. Releasing also takes the session out of the line. |
| `holdHuman({purpose, ttlMs})` | The person at the device takes it. Every session is refused, the session it displaced goes to the head of the line, and only an explicit `release({human: true})` or the TTL ends it. |
| `status` | The live lease and the line. |

A lease also ends when no heartbeat arrives within its TTL. With an `isLive(sessionId)` callback, it ends as soon as the holder's session is gone. A waiter that stops polling (`acquire`, or a refused `authorize`) for `QUEUE_STALE_MS` drops out of the line. During a human hold no waiter ages out, and when the hold ends every waiter's clock restarts, so the session it displaced keeps its place however long the person held the resource.

Defaults: explicit lease 10 min, implicit 90 s, human hold 15 min, line staleness 60 s.

Every call runs in one `BEGIN IMMEDIATE` transaction, so two sessions cannot both win a free resource (`tests/resource-leases.test.mjs` races eight processes).
