# Binary Headers Refactor Plan

## Status

```text
Phase 1: done
Phase 2: done
Phase 3: done
Phase 4: done
```

Current green validation:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/memtier-bench.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/abort-timeout.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats-e2e.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/**.spec.ts' 2>&1
```

Current broad result:

```text
444 passing
23 pending
```

Environment note:

```text
abort-timeout.spec.ts opens a local listener.
In a restricted sandbox it can fail before reaching queue logic with:
  listen EPERM: operation not permitted 0.0.0.0
```

Important test harness note:

```text
stats-e2e.spec.ts must import ../../index, not ../..
```

Why:

```text
../.. from packages/client/lib/binary-headers/stats-e2e.spec.ts
  -> packages/client/package.json
  -> main = ./dist/index.js

That bypasses source changes in lib/.
```

Current source import:

```ts
import { createClient, RedisClientType } from '../../index';
```

## Historical Baseline

Original red test command:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
```

Original intentional failures:

```text
1. flushWaitingForReply clears pending outbound data and cancels scheduled timer
2. flushAll clears pending outbound data and cancels scheduled timer
3. OutboundCodec intercept errors reject the command and leave the queue usable
```

Those failures were useful because they pinned the ownership bug before refactoring.

## Root Problem

The queue used to move a command into `waitingForReply` too early.

Historical shape:

```ts
this.#waitingForReply.push(toSend);
let outputs = outbound.push(encoded, args, byteLength, currentChainId);
```

Visual model:

```text
today-before-refactor

  toWrite
    |
    v
  waitingForReply      <-- queue says: "sent"
    |
    +--> outbound codec
           |
           +--> maybe still buffered
           +--> maybe timer flushes later
```

That broke the old invariant:

```text
waitingForReply should mean:
  "these commands were actually emitted to the socket"
```

It also caused the two concrete failure modes we pinned first:

```text
- queue flush paths could reject commands but still leave bytes buffered
- outbound interceptor exceptions could strand commands in queue state
```

## Refactor Goal

Restore a single ownership rule:

```text
before emit:
  outbound codec owns buffered commands

after emit:
  queue owns waitingForReply commands
```

Queue should remain responsible for:

```text
- toWrite
- waitingForReply
- abort/timeout listener lifecycle
- decoder / pubsub / reset
- queue length / offline queue semantics
```

Outbound codec should own:

```text
- batching
- buffered command ownership
- slot/eligibility policy
- chain / explicit-pipeline batching policy
- timer-based flush policy
```

Inbound is already close to the right shape and should mostly stay alone in this refactor.

## Phase 1: Fix Ownership Without Moving Timers Yet

Status: done

### Goal

Make the outbound codec return not only bytes, but also the exact commands that became "sent".

### What Landed

The transitional outbound protocol now includes batch metadata:

```ts
export interface WriteBatch {
  writes: SocketChunks;
  emittedCommands: ReadonlyArray<CommandToWrite>;
}

export interface OutboundCodec {
  push(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    meta?: WriteCommandMeta
  ): WriteBatch | null;

  drain(reason: FlushReason): WriteBatch | null;
  hasBuffered(): boolean;
  reset(): CommandToWrite[];
}
```

Queue-side ownership helpers now exist:

```ts
#markSent(command)
#markBatchSent(batch)
#resetPendingOutbound(err)
#handleOutboundError(err, current?)
```

The codec now buffers command objects alongside payload chunks:

```text
- eligible buffered commands stay codec-owned until emitted
- drain() returns both writes and the exact emitted commands
- reset() clears buffered payload and returns buffered commands for rejection
```

### Acceptance

```text
- the 3 original red regression tests are green
- waitingForReply means emitted-to-socket commands only
- interceptor failures reject commands without throwing from the generator
```

### Validation

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats.spec.ts' 2>&1
```

## Phase 2: Move Segment / Explicit-Pipeline Policy Into The Codec

Status: done

### Goal

Delete queue-side batching policy branches and move them behind outbound codec calls.

### Queue Policy That Needed To Move

Before this phase, the queue still owned:

```text
- chain-boundary flush logic
- force-immediate flush for abort/timeout commands
- pendingIsExplicitPipeline bookkeeping
- end-of-iteration "drain now vs let timer handle it" logic
```

### Transitional Protocol For Phase 2

The queue now passes command metadata instead of running segment policy itself:

```ts
export interface WriteCommandMeta {
  chainId?: symbol;
  forceImmediate?: boolean;
}
```

The outbound boundary grows two transitional helpers:

```ts
export interface OutboundCodec {
  push(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    meta?: WriteCommandMeta
  ): WriteBatch | null;

  drain(reason: FlushReason): WriteBatch | null;
  completePushes(): WriteBatch | null;
  hasBuffered(): boolean;
  reset(): CommandToWrite[];
}
```

Visual model:

```text
queue tells codec:
  "here is the next command and its metadata"

codec decides:
  "buffer / flush / start new segment / force immediate send / whether timer applies"
```

### What Has Landed So Far

Queue loop simplification:

```text
removed from commands-queue.ts:
  - currentChainId
  - pendingIsExplicitPipeline
  - queue-side chain boundary drain
  - queue-side force-immediate drain merge
  - queue-side end-of-iteration explicit drain decision
```

Codec-owned segment state:

```text
added to codec.ts:
  - pendingChainId
  - pendingRequiresDrainAtEnd
  - chain-boundary drain for explicit segment transitions
  - forceImmediate drain for abort/timeout commands
  - completePushes() for "drain now vs wait for timer"
```

Important behavior preserved:

```text
- auto commands can still be absorbed into a later explicit segment
- explicit segments never leak into the following segment
- explicit pipelines still drain immediately even when a scheduler exists
- timer scheduling still happens only for auto-pipelining segments
```

### Acceptance For Phase 2

```text
- queue no longer owns segment / explicit-pipeline batching policy
- queue no longer owns force-immediate drain policy
- codec queue tests stay green
- integration-heavy queue specs stay green
```

### Validation

Green:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/memtier-bench.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats-e2e.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/**.spec.ts' 2>&1
```

Current broad result:

```text
444 passing
23 pending
```

Open decision left for Phase 3:

```text
the queue/codec boundary has a dedicated
completePushes() hook for "no more push() calls for now".
```

## Phase 3: Move Timer Ownership Into The Codec

Status: done

### Goal

Delete queue-owned timer state and callback plumbing.

### What Landed

```text
queue
  - no longer owns scheduler / pendingFlush / scheduleFlush / cancelPendingFlush
  - binds the outbound codec once via WriteSink
  - exposes a generic WriteHandler instead of a timer-specific callback

codec
  - owns scheduler / pendingFlush / scheduleFlushIfNeeded / cancelPendingFlush
  - owns timer expiry -> flush -> emit(batch) flow
  - owns the "reschedule after slot-change flush" behavior

index
  - passes timer config into BinaryHeadersOutboundOptions.timer
  - wires queue.setWriteHandler(...) to socket.write(...)
```

Landed queue/codec bridge:

```ts
interface WriteSink {
  emit(batch: WriteBatch): void;
  onError(err: unknown): void;
}

type WriteHandler = (writes: SocketChunks) => void;
```

Visual model:

```text
before Phase 3
  queue timer fires
    -> queue asks codec to drain
    -> queue callback writes bytes

after Phase 3
  codec timer fires
    -> codec creates WriteBatch
    -> codec calls sink.emit(batch)
    -> queue marks batch.emittedCommands as waitingForReply
    -> queue callback writes batch.writes
```

### Acceptance

```text
- queue timer state is gone
- timer scheduling/cancellation lives in the codec
- timer callback wiring in index.ts is now generic ready-to-write wiring
- all timer tests pass against codec-owned scheduling
- queue no longer knows whether outbound codec buffers or uses timers
```

Compatibility shims intentionally kept for now:

```text
- setWriteHandler(...)
- hasPendingOutbound()
```

These are wrappers over codec state for tests/diagnostics, not queue-owned timer machinery.

### Validation

Green:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/memtier-bench.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/abort-timeout.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats-e2e.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/**.spec.ts' 2>&1
```

Important Phase 3 bug fix:

```text
slot-change flushes that happened inside codec packing needed to cancel
the old timer before starting the new buffered segment
```

Without that cancel, these tests failed:

```text
- slot flush mid-generator cancels existing timer and schedules new one
- scheduler cancel is called on slot-change flush
- auto-pipelining with slot changes: timer scheduled for remaining
```

## Phase 4: Clean-Up / Naming Pass

Status: done

### Goal

Make the outward-facing abstractions read like a transport plugin instead of a half-queue.

### Naming Work Already Landed

```text
- setWriteHandler(...) is the queue callback name
- queue/index wiring no longer talks about "timer flush callback"
- sent -> emittedCommands
- intercept() -> push() / decode()
- flush() -> drain()
- hasPending() -> hasBuffered()
- BinaryHeaders*Interceptor -> BinaryHeaders*Codec
```

This is a useful midpoint because the callback semantics are now accurate:

```text
the queue callback is not timer-only anymore
it is the generic path for ready socket writes
```

### Breaking Renames That Landed

```text
OutboundInterceptor -> OutboundCodec
InboundInterceptor  -> InboundCodec
WireInterceptor     -> WireCodec
OutboundBatch       -> WriteBatch
OutboundCommandMeta -> WriteCommandMeta
OutboundSink        -> WriteSink
ReadyToWriteCallback -> WriteHandler
setReadyToWriteCallback(...) -> setWriteHandler(...)
setTimerFlushCallback(...)   -> removed
BinaryHeadersInterceptor -> BinaryHeadersCodec
BinaryHeadersOutboundInterceptor -> BinaryHeadersOutboundCodec
BinaryHeadersInboundInterceptor  -> BinaryHeadersInboundCodec
BinaryHeadersInterceptorOptions  -> BinaryHeadersCodecOptions
createBinaryHeadersInterceptor() -> createBinaryHeadersCodec()
intercept() -> push() / decode()
flush()     -> drain()
hasPending() -> hasBuffered()
sent -> emittedCommands
```

### Validation

Green:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/memtier-bench.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/stats-e2e.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/**.spec.ts' 2>&1
```

### Acceptance

```text
- no semantic changes
- only naming / docs / minor test cleanup
```

## Implementation Order

```text
1. Phase 1 ownership fix
2. Phase 2 segment-policy move
3. Phase 2 verification on heavy integration suites
4. Phase 3 timer move
5. Phase 4 naming cleanup
```

## Done Criteria

The refactor is done when all of these are true:

```text
- waitingForReply means emitted-to-socket only
- codec reset clears buffered commands and returns them for rejection
- outbound exceptions reject commands instead of exploding the generator
- queue no longer owns batching semantics
- queue no longer owns timer semantics
- outbound protocol is smaller and easier to reason about
```
