# Agent Note: Team mail recovery waits for the Lead flush

Status: implemented

English | [中文](2026-09-06-team-mail-recovery-waits-for-lead-flush.zh.md)

## Problem

The Agent Teams mailbox ([feature note](../feature/2026-08-05-agent-teams.md)) appends `team/message/queued` to the Lead Session and flushes before attempting delivery. The recovery pass that runs when a Team member Session starts read the live Team projection outside the Lead transaction. `Session.append` publishes an event into that projection before its flush completes, and a Lead transaction whose flush rejects still leaves its row in the projection, so recovery could observe records the Lead log did not yet hold.

Two consequences followed. First, a recovery pass that ran while a sender's queued flush was pending claimed that record and delivered it; the sender registered its own dispatch only after the flush and, finding the record already in flight, reported `queued` for a message that was in fact delivered once. The persistence test `reconciles a persisted child to active and a missing child to durable failed` reached this window whenever its wakeup send landed inside the reconciliation transaction's flush, which CI I/O contention made likely. Second, a record whose durability flush failed remained deliverable by the next recovery pass with no durable Lead record behind it.

## Decision

**Recovery snapshots and claims pending mail inside the Lead transaction, after a flush.** When a member start has candidate queued-minus-delivered records, `TeamMailbox.recoverFor` runs `sessions.flush(root.session)` under `journal.transact`, re-checks that the Lead is still the exact live registry entry, captures the candidates, and registers each dispatch before the transaction releases. Delivery is awaited only after release, because delivery checkpoints through the same journal. The complete pass is tracked with the other dispatch transactions, so runtime disposal awaits it. A start with no candidate records returns before any transaction or flush. A rejected flush rejects the pass, which the recovery scheduler reports as a warning, and delivers nothing; the persistence write-behind retains the rejected batch and retries it on the next flush, after which a later pass delivers the record.

**The in-flight set stays a set.** A sender queues a fresh record id and registers its own dispatch inside its producing transaction, before any recovery pass can capture that record, so no public sender path can find its record already in flight; only a recovery pass can be declined by the set, and its declined result is discarded. The `accepted`/`queued` receipt therefore keeps its existing meaning as the sender's own immediate observation.

**Memory semantics.** `sessions.flush()` reports whether any durability listener participated; the mailbox does not interpret `false` as an acknowledgement or require a backend. Without a persistence backend, recovery keeps the same in-memory contract as every other Team flush.

Target-local FIFO admission, the Lead transaction order, disposal ordering, and target-Session de-duplication are unchanged.

## Alternatives considered

**Wait in the test for recovery to finish before sending.** Rejected: recovery is a fire-and-forget pass with no completion signal, so the test would rely on scheduler order, and the underlying delivery-before-durability ordering would remain.

**Read the projection inside the transaction without flushing.** Rejected: the journal's transaction tail deliberately swallows a failed operation, and the projection already holds the row of a rejected `appendAndFlush`, so serialization alone cannot prove a record is durable.

**Track failed rows in a poison set.** Rejected: the write-behind already retains and retries the rejected batch, so the next successful flush is the durability proof; a separate map would duplicate that state.

## Consequences

Recovery now pays one Lead flush per member start that has candidate mail, and a Lead whose durability is failing delivers no recovered mail until a flush succeeds; that mail stays visible as pending. A sender whose `sendMessage()` rejected because its flush failed has an unknown outcome: the record stays pending in the live projection and a later pass delivers it once the retained write succeeds, so a rejected send is not a guarantee of non-delivery. Recovery dispatches for one member now enter their target queues in one synchronous span instead of one after another; each target's queue order is unchanged.

## Testing

`persistence.spec.ts` holds the Lead's flush acknowledgements through a `session/flush` listener: it lands the wakeup send inside the reconciliation flush window, proves that no child starts and no delivery occurs while the queued record is unacknowledged, then releases the barrier and checks an `accepted` receipt, exactly one target delivery, and exactly one durable `team/message/delivered` record. Further cases make the Lead flush reject during recovery and during a send, observe the recovery warning through a logger exporter, prove the record stays pending with no delivery, and show a later pass delivering it exactly once after the flush recovers; hold the recovery flush while the runtime disposes and while the Lead handle is disposed, proving disposal waits for the pass and a stale Lead claims nothing; and count Lead flushes on a start with no candidate mail. Every case that exercises the gate fails against the previous mailbox.
