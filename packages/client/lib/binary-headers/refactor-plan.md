# Binary Headers Refactor Plan

## Baseline

Current red test command:

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
```

Current intentional failures:

```text
1. flushWaitingForReply clears pending outbound data and cancels scheduled timer
2. flushAll clears pending outbound data and cancels scheduled timer
3. OutboundInterceptor intercept errors reject the command and leave the queue usable
```

These failures are good. They pin the boundary bug before refactoring.

## Root Problem

The queue currently moves a command into `waitingForReply` too early.

File: `packages/client/lib/client/commands-queue.ts`
Lines: `677-683`

```ts
this.#chainInExecution = toSend.chainId;
toSend.chainId = undefined;
this.#waitingForReply.push(toSend);

if (outbound !== null) {
  const hadPending = outbound.hasPending();
  let outputs = outbound.intercept(encoded, args, byteLength, currentChainId);
```

Visual model:

```text
today

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

That breaks the old invariant:

```text
waitingForReply should mean:
  "these commands were actually emitted to the socket"
```

Right now it means:

```text
"these commands are somewhere between queue state and codec state"
```

That is why:

- queue flush paths can reject a command but still leave bytes buffered in the codec
- outbound interceptor exceptions can strand commands in `waitingForReply`

## Refactor Goal

Restore a single ownership rule:

```text
before emit:
  outbound codec owns buffered commands

after emit:
  queue owns waitingForReply commands
```

The queue should remain responsible for:

```text
- toWrite
- waitingForReply
- abort/timeout listeners
- decoder / pubsub / reset
- queue length / offline queue semantics
```

The outbound codec should own:

```text
- batching
- buffered command ownership
- slot/eligibility policy
- chain / explicit-pipeline batching policy
- timer-based flush policy
```

Inbound is already close to the right shape and should mostly stay alone in this refactor.

## Concrete Phases

---

## Phase 1: Fix Ownership Without Moving Timers Yet

### Goal

Make the outbound codec return not only bytes, but also the exact commands that became "sent".

This is the smallest step that fixes the ownership bug.

### Files

```text
packages/client/lib/client/commands-queue.ts
packages/client/lib/binary-headers/codec.ts
packages/client/lib/binary-headers/packing.ts          (only if needed)
packages/client/lib/binary-headers/codec-queue.spec.ts
```

### New Protocol

Replace the current outbound "bytes only" protocol:

File: `packages/client/lib/client/commands-queue.ts`
Lines: `46-74`

```ts
export interface OutboundInterceptor {
  intercept(
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    chainId?: symbol
  ): SocketChunks;

  flush(reason: FlushReason): SocketChunk | null;
  hasPending(): boolean;
}
```

with a transitional protocol like:

```ts
export interface OutboundBatch {
  writes: SocketChunks;
  sent: CommandToWrite[];
}

export interface OutboundInterceptor {
  intercept(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    chainId?: symbol
  ): OutboundBatch | null; // null => buffered, nothing emitted

  flush(reason: FlushReason): OutboundBatch | null;

  hasPending(): boolean;

  reset?(): CommandToWrite[];
}
```

### Queue Changes

#### 1. Add a single helper that performs the "sent" transition

File: `packages/client/lib/client/commands-queue.ts`

Add something like:

```ts
#markSent(command: CommandToWrite) {
  (command as any).args = undefined;

  if (command.abort) {
    RedisCommandsQueue.#removeAbortListener(command);
    command.abort = undefined;
  }

  if (command.timeout) {
    RedisCommandsQueue.#removeTimeoutListener(command);
    command.timeout = undefined;
  }

  this.#chainInExecution = command.chainId;
  command.chainId = undefined;
  this.#waitingForReply.push(command);
}
```

#### 2. Stop pushing into `waitingForReply` before outbound success

Replace the current ordering:

```ts
this.#waitingForReply.push(toSend);
let outputs = outbound.intercept(...);
```

with:

```ts
const batch = outbound.intercept(toSend, encoded, args, byteLength, currentChainId);
if (batch !== null) {
  for (const sent of batch.sent) {
    this.#markSent(sent);
  }

  for (const output of batch.writes) {
    yield output;
  }
}
```

#### 3. Wrap outbound calls in `try/catch`

Current unguarded call:

File: `packages/client/lib/client/commands-queue.ts`
Lines: `681-689`

```ts
const hadPending = outbound.hasPending();
let outputs = outbound.intercept(encoded, args, byteLength, currentChainId);
```

Needs to become guarded:

```ts
try {
  const batch = outbound.intercept(...);
  ...
} catch (err) {
  RedisCommandsQueue.#flushToWrite(toSend, err as Error);
  throw? // no
}
```

Important behavior:

```text
interceptor failure should reject the command
interceptor failure should not throw out of the generator
interceptor failure should leave the queue reusable
```

#### 4. Clear codec-owned buffered commands on queue flush/reset paths

Current code only resets queue-owned structures:

File: `packages/client/lib/client/commands-queue.ts`
Lines: `789-815`

```ts
flushWaitingForReply(err: Error): void {
  this.resetDecoder();
  this.#pubSub.reset();

  this.#flushWaitingForReply(err);
  ...
}

flushAll(err: Error): void {
  this.resetDecoder();
  this.#pubSub.reset();
  this.#flushWaitingForReply(err);
  ...
}
```

Add:

```ts
this.#cancelPendingFlush();
const buffered = this.#outbound?.reset?.() ?? [];
for (const command of buffered) {
  RedisCommandsQueue.#flushToWrite(command, err);
}
```

Also do the same in `destroy()` if buffered outbound state still exists.

### Codec Changes

#### 1. Buffer commands inside the codec together with payload

Today the codec owns bytes but not command objects.

File: `packages/client/lib/binary-headers/codec.ts`
Lines: `81-129`

```ts
const packed = this.#packer.add(encoded, slot, payloadLength);
if (!packed) {
  return [];
}
return [packed];
```

It should instead also track the associated `CommandToWrite`.

Implementation options:

```text
Option A:
  keep a parallel array of buffered commands inside codec.ts

Option B:
  extend CommandPacker to store metadata
```

Preferred for Phase 1:

```text
Option A
```

Reason:

```text
smaller change surface
easier to verify
lets packing.ts stay payload-focused for now
```

Sketch:

```ts
#bufferedCommands: CommandToWrite[] = [];

intercept(command, encoded, args, byteLength, chainId) {
  ...
  const packed = this.#packer.add(encoded, slot, payloadLength);
  this.#bufferedCommands.push(command);

  if (!packed) {
    return null;
  }

  const sent = this.#bufferedCommands;
  this.#bufferedCommands = [];
  return { writes: [packed], sent };
}
```

When an ineligible command forces a drain:

```ts
const pending = this.#packer.drain(FlushReason.DRAIN);
if (!pending) {
  return { writes: [encoded], sent: [command] };
}

const sent = [...this.#bufferedCommands, command];
this.#bufferedCommands = [];
return { writes: [pending, encoded], sent };
```

#### 2. Add `reset()` to the outbound codec

Sketch:

```ts
reset(): CommandToWrite[] {
  this.#packer.drain(FlushReason.DRAIN); // discard bytes
  const buffered = this.#bufferedCommands;
  this.#bufferedCommands = [];
  this.#chainSlotCache.clear();
  this.#lastChainId = undefined;
  return buffered;
}
```

### Acceptance For Phase 1

```text
- the 3 red regression tests go green
- existing queue tests stay green
- invariant restored:
    waitingForReply == emitted-to-socket commands only
```

---

## Phase 2: Move Segment / Explicit-Pipeline Policy Into The Codec

### Goal

Delete queue-side batching policy branches and move them behind outbound codec calls.

### Files

```text
packages/client/lib/client/commands-queue.ts
packages/client/lib/binary-headers/codec.ts
packages/client/lib/binary-headers/codec-queue.spec.ts
packages/client/lib/binary-headers/memtier-bench.spec.ts
```

### Queue Code To Delete

#### 1. Chain-boundary flush logic

File: `packages/client/lib/client/commands-queue.ts`
Lines: `633-645`

```ts
if (outbound !== null && outbound.hasPending()) {
  const chainChanged = currentChainId !== undefined && toSend.chainId !== currentChainId;
  if (chainChanged) {
    this.#cancelPendingFlush();
    const drained = outbound.flush(FlushReason.DRAIN);
    if (drained !== null) {
      yield drained;
    }
    pendingIsExplicitPipeline = false;
  }
}
```

#### 2. Force-immediate flush logic

File: `packages/client/lib/client/commands-queue.ts`
Lines: `685-692`

```ts
if (needsImmediateFlush && outbound.hasPending()) {
  this.#cancelPendingFlush();
  const drained = outbound.flush(FlushReason.DRAIN);
  if (drained !== null) {
    outputs = outputs.length > 0 ? [...outputs, drained] : [drained];
  }
}
```

#### 3. End-of-iteration drain policy

File: `packages/client/lib/client/commands-queue.ts`
Lines: `727-744`

```ts
if (outbound !== null && outbound.hasPending()) {
  if (this.#scheduler === null || pendingIsExplicitPipeline) {
    this.#cancelPendingFlush();
    const drained = outbound.flush(FlushReason.DRAIN);
    if (drained !== null) {
      yield drained;
    }
  }
}
```

### Replace With Command Metadata

Introduce a small metadata object:

```ts
export interface OutboundCommandMeta {
  chainId?: symbol;
  forceImmediate?: boolean;
  endOfIteration?: boolean;
}
```

Then change the outbound entrypoint to:

```ts
push(
  command: CommandToWrite,
  encoded: SocketChunk,
  args: CommandArguments,
  byteLength: number,
  meta: OutboundCommandMeta
): OutboundBatch | null;
```

### Why

This changes the relationship from:

```text
queue tells codec:
  "I inspected your hidden state and decided when you flush"
```

to:

```text
queue tells codec:
  "here is the next command and its metadata"

codec decides:
  "buffer / flush / start new segment / force immediate send"
```

### Acceptance For Phase 2

```text
- remove queue-side chain/pipeline batching branches
- codec queue tests still green
- queue becomes transport-agnostic again
```

---

## Phase 3: Move Timer Ownership Into The Codec

### Goal

Delete queue-owned timer state and callback plumbing.

### Queue Code To Delete

#### 1. Queue timer state

File: `packages/client/lib/client/commands-queue.ts`
Lines around:

```ts
#scheduler
#maxWaitMs
#pendingFlush
#timerFlushCallback
```

#### 2. Queue timer scheduling

File: `packages/client/lib/client/commands-queue.ts`
Lines: `284-296`

```ts
#scheduleFlush(): void {
  if (this.#pendingFlush !== null || this.#scheduler === null) {
    return;
  }

  this.#pendingFlush = this.#scheduler.schedule(this.#maxWaitMs, () => {
    this.#pendingFlush = null;
    const packed = this.drainPendingOutbound(FlushReason.TIMER_EXPIRED);
    if (packed !== null) {
      this.#timerFlushCallback(packed);
    }
  });
}
```

#### 3. Queue public timer helpers

File: `packages/client/lib/client/commands-queue.ts`
Lines: `755-760`

```ts
hasPendingOutbound(): boolean {
  return this.#outbound?.hasPending() ?? false;
}

drainPendingOutbound(reason: FlushReason = FlushReason.DRAIN): SocketChunk | null {
  return this.#outbound?.flush(reason) ?? null;
}
```

#### 4. Index callback wiring

File: `packages/client/lib/client/index.ts`
Lines: `729-735`

```ts
#setupBinhdrFlushCallback(): void {
  const binaryHeadersOpts = this.#normalizedBinaryHeadersOptions();
  if (binaryHeadersOpts?.enabled && binaryHeadersOpts.timer !== false) {
    this.#queue.setTimerFlushCallback(encoded => {
      this.#socket.write([encoded]);
    });
  }
}
```

### Target Shape

Bind the outbound codec to a queue-owned emit sink once:

```ts
interface OutboundSink {
  emit(batch: OutboundBatch): void;
}

interface OutboundInterceptor {
  bind(sink: OutboundSink): void;
  push(...): OutboundBatch | null;
  endIteration(): OutboundBatch | null;
  reset(): CommandToWrite[];
  stats?(): BinaryHeaderStats;
}
```

Then timer behavior becomes codec-internal:

```text
codec timer fires
  -> codec creates OutboundBatch
  -> codec calls sink.emit(batch)
  -> queue marks batch.sent as waitingForReply
  -> socket writes batch.writes
```

### Constructor Shape After Phase 3

Instead of:

```ts
new RedisCommandsQueue(..., interceptor, timerOptions)
```

target:

```ts
new RedisCommandsQueue(..., interceptor)
```

with timer configuration living inside the outbound codec options:

```ts
new BinaryHeadersInterceptor({
  outbound: {
    resolver: STATIC_RESOLVER,
    maxCommandCount,
    maxPayloadLength,
    timer: {
      maxWaitMs,
      scheduler
    }
  },
  ...
})
```

### Acceptance For Phase 3

```text
- delete queue timer helpers
- delete queue timer callback wiring from index.ts
- all timer tests pass against codec-owned scheduling
- queue no longer knows whether outbound codec buffers or uses timers
```

---

## Phase 4: Clean-Up / Naming Pass

### Goal

Make the outward-facing abstractions read like a transport plugin instead of a half-queue.

### Candidate Renames

```text
OutboundInterceptor -> OutboundCodec
InboundInterceptor  -> InboundCodec
WireInterceptor     -> WireCodec
intercept()         -> push() / decode()
flush()             -> drain()
```

This phase is optional. Do it only after the ownership and timer moves are stable.

### Acceptance For Phase 4

```text
- no semantic changes
- only naming / docs / minor test cleanup
```

## Implementation Order

Do not skip the order.

```text
1. Keep the red regression tests
2. Implement Phase 1 and make tests green
3. Re-run codec queue + memtier queue tests
4. Only then start deleting queue-side batching logic in Phase 2
5. Move timer ownership in Phase 3
6. Naming cleanup last
```

## Suggested Commands Per Phase

### Phase 1

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
```

### Phase 2

```sh
npm run test-single -- 'packages/client/lib/binary-headers/codec-queue.spec.ts' 2>&1
npm run test-single -- 'packages/client/lib/binary-headers/memtier-bench.spec.ts' 2>&1
```

### Phase 3

```sh
npm run test-single -- 'packages/client/lib/binary-headers/**.spec.ts' 2>&1
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
