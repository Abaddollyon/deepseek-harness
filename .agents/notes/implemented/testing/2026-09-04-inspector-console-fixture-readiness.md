# Agent Note: Synchronize Inspector Console fixtures on Client readiness

Status: implemented

English | [中文](2026-09-04-inspector-console-fixture-readiness.zh.md)

## Problem

The Inspector integration fixture enables Runtime through a DevTools connection and emits its simulated page `console.log` through a Worker `parentPort`. These are independent channels. A successful `Runtime.enable` response proves that the Inspector Worker queued the Client Console enable frame, but it does not prove that the Client Worker processed that frame and installed its Console observer before a fixture request arrives over `parentPort`.

The complete ten-test Inspector integration file exposed this missing ordering edge: the first DevTools session could lose the only Console event, while the same case passed alone. Longer waits after the log cannot recover an event emitted before the hook existed.

## Decision

The two-session Client Console integration case performs one harmless `Runtime.evaluate` in each announced Client context after both sessions enable Runtime and before it asks the fixture to log. Client Runtime commands and Client Console enable frames use the same authenticated source socket described by the [cross-realm Inspector decision](../architecture/2026-08-23-cross-realm-cdp-inspector.md). Each successful evaluation therefore establishes same-socket ordering behind its session's previously queued Console enable frame. The test asserts both evaluation results before crossing to the independent fixture port.

The fixture still emits one external Console call, and the existing assertions still require both sessions to receive it, retain distinct object ids, reject cross-session lookup, and release one session without invalidating the other. This synchronization is test coordination; it does not redefine `Runtime.enable` as a Client hook-readiness acknowledgement.

## Alternatives considered

**Increase the event wait or add a sleep.** Rejected because elapsed time does not establish that the Client Worker processed the enable frame, and a Console event lost before hook installation cannot arrive later.

**Retry the fixture log.** Rejected because it weakens the one-call fan-out contract and can hide the first lost event.

**Emit the Console call through `Runtime.evaluate`.** Rejected because the test intentionally covers a page-originated call entering through a channel independent of the Inspector control socket.

**Add a Console-enable acknowledgement to the production protocol.** Deferred because this repair needs deterministic fixture setup, not a new promise that `Runtime.enable` orders arbitrary external page actions. If a production consumer requires that stronger readiness contract, the protocol must acknowledge Client hook installation explicitly and receive separate implementation and compatibility review.

## Consequences

The integration case synchronizes on observable Client work rather than scheduler timing and remains deterministic when the complete file changes Worker scheduling. It adds two bounded Client Runtime round trips to that case and keeps the production protocol unchanged.

The barrier depends on Runtime and Console control frames retaining their shared ordered source socket. A future transport split must provide another explicit readiness signal before the independent fixture log. This test does not prove a production-level acknowledgement contract for `Runtime.enable`.
