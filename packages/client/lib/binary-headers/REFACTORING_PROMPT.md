# Binary Headers Queue Refactoring Task

## Goal

**Achieve the simplicity of pluggable codecs (from `binary-headers` branch) with the performance we achieved (from `binary-headers-old` branch, which is actually faster than master).**

This is primarily a **code cleanup and interface design** task.

---

## Current Situation

### Branch Naming (Confusing!)

- **`binary-headers`** branch = OLDER implementation with generic `Codec` abstraction (clean interfaces, but slow)
- **`binary-headers-old`** branch = NEWER implementation, current working branch (fast, but less elegant)

### What We've Achieved

The current `binary-headers-old` branch is **faster than master** while supporting binary headers. We accomplished this by:

1. Using **subclassing** instead of codec injection with `.bind()`
2. Making queue internals `protected` for subclass access
3. Adding hook methods (`transformOutbound`, `drainOutbound`) that have zero cost when not overridden
4. **Eliminating generator delegation overhead** (this was the biggest win!)

### Key Performance Insight: Generators Are Expensive

We discovered that `yield*` delegation was causing ~37% encoding overhead. The original approach:

```typescript
// SLOW - generator delegation creates allocations every call
protected *transformOutbound(encoded, args): Generator<...> {
  yield encoded;
}

// In commandsToWrite():
yield* this.transformOutbound(encoded, args);
yield* this.drainOutbound();
```

Even when the base class just yields a single value (or nothing), `yield*` creates a new generator object every call and uses the generator delegation protocol.

**The fix** - return `T | null` instead of generators:

```typescript
// FAST - no allocations
protected transformOutbound(encoded, args): ReadonlyArray<RedisArgument> | null {
  return encoded;
}

// In commandsToWrite():
const result = this.transformOutbound(encoded, args);
if (result !== null) yield result;
```

This brought "No codec" overhead from **36.6% down to ~2%** compared to master.

### What We Lost

The original `binary-headers` branch had a cleaner, more pluggable design:

```typescript
// Clean pluggable interface from binary-headers branch
interface CommandCodec {
  readonly outbound: OutboundInterceptor;
  readonly inbound: InboundInterceptor;
}

// Could be injected at construction
new RedisCommandsQueue(respVersion, maxLength, onShardedChannelMoved, codec);
```

But this required `.bind()` in the constructor to switch between codec/no-codec paths, which killed performance.

---

## The Challenge

**Design codec interfaces that allow pluggability WITHOUT paying the performance cost.**

Key insight: The performance problem wasn't the codec abstraction itself, but how we integrated it (dynamic method assignment with `.bind()`).

### Questions to Explore

1. **Can we have pluggable codecs via subclassing?** (Current approach - works, but is subclassing the right abstraction?)

2. **Can we use composition without `.bind()` overhead?** Perhaps by:
   - Using direct property access instead of bound methods
   - Having the codec be a simple object with functions, not requiring `this` binding
   - Inlining codec calls at specific hook points

3. **How do we avoid generator overhead while keeping the interface clean?**
   - The original codec interface returned `OutboundCommand | null` which is good
   - But if a codec needs to yield multiple items (e.g., flush buffer returns batched + current), how do we handle that efficiently?
   - Should we use arrays? Iterators? Multiple calls?

4. **What's the minimal interface for a codec?** The original `binary-headers` branch had:
   ```typescript
   interface OutboundInterceptor {
     process(command: OutboundCommand): OutboundCommand | null;  // transform or buffer
     drain(): OutboundCommand | null;  // flush buffered commands
   }

   type InboundInterceptor = (chunk: Buffer, next: InboundNext) => void;

   interface CommandCodec {
     readonly outbound: OutboundInterceptor;
     readonly inbound: InboundInterceptor;
   }
   ```

5. **Critical: Can time-based flushing work with the original interface?**

   The original interface only calls `drain()` at the end of `commandsToWrite()` iteration. But what happens when:
   - Commands are buffered (waiting for more to batch)
   - No new commands arrive
   - The buffer sits there forever

   **Options to consider:**
   - Should the codec interface include timer/scheduling hooks?
   - Should the queue expose `hasPendingOutbound()` + `flushPendingOutbound()` for external scheduling?
   - Can the codec implementation handle its own timers internally and push data out via callback?
   - Or is time-based flushing entirely the consumer's (socket layer's) responsibility?

6. **Can we make the base queue completely unaware of codecs?** And have the codec integration happen at a higher layer?

---

## Time-Based Flushing Complexity

Binary headers buffer multiple commands. Problem: if commands stop arriving, the buffer never flushes.

Current solution uses `Scheduler` + `TimerFlushCallback` which creates coupling between queue and socket layer.

**Consider:** Is there a simpler approach? Maybe:
- The socket layer polls for pending data on a timer
- The queue just exposes `hasPendingOutbound()` and `flushPendingOutbound()`
- Flush timing becomes the consumer's responsibility, not the queue's

---

## Key Files

| File | Description |
|------|-------------|
| `lib/client/commands-queue.ts` | Current queue with subclassing hooks |
| `lib/binary-headers/master-queue.ts` | Original master queue (performance baseline) |
| `lib/binary-headers/binhdr-commands-queue.ts` | Binary headers subclass |
| `lib/binary-headers/queue-codec-bench.ts` | Benchmark tool - use this to validate changes |

Run `git diff binary-headers` to see the original codec interface design.

---

## Success Criteria

1. **Performance:** Current branch is faster than master - maintain or improve this
2. **Simplicity:** Codec integration should be obvious and minimal
3. **Pluggability:** Should be easy to add new codecs without modifying queue internals
4. **Code reduction:** Less code, fewer integration points, smaller API surface

---

## Deliverables

1. **Proposed codec interface design** - What should `OutboundInterceptor`, `InboundInterceptor`, and `CommandCodec` look like?

2. **Integration strategy** - How does the codec plug into the queue without performance penalty?

3. **Time-based flush solution** - How to handle the "commands stop arriving" problem cleanly?

4. **Refactored code** - Clean up the current implementation based on the above

---

## Constraints

- TypeScript
- No new external dependencies
- Must preserve all existing queue functionality (PubSub, MONITOR, abort signals, timeouts, maintenance mode) and if possible not change the original queue implementation besides adding codec support
- Performance is critical - this is a hot path
- Simple and explicit control flow: Favor straightforward control structures over complex logic. Simple control flow makes code easier to understand and reduces the risk of bugs.
- Set explicit upper bounds on loops, queues, and other data structures. Fixed limits prevent infinite loops and uncontrolled resource use.
- Limit function length: Keep functions concise, ideally under 70 lines. Shorter functions are easier to understand, test, and debug.
- Centralize control flow: Keep switch or if statements in the main parent function, and move non-branching logic to helper functions. Let the parent function manage state, using helpers to calculate changes without directly applying them. Keep leaf functions pure and focused on specific computations. This divides responsibility: one function controls flow, others handle specific logic.

---

## Implementation (Completed)

### What We Built

We created a **composition-based codec design** that achieves zero overhead when no codec is used, while providing clean pluggability.

#### New Files Created

| File | Description |
|------|-------------|
| `lib/binary-headers/codec-queue.ts` | Master queue + minimal codec support (~110 lines added) |
| `lib/binary-headers/codec.ts` | BinaryHeadersCodec implementation |
| `lib/binary-headers/codec-queue.spec.ts` | 19 tests for the new implementation |
| `lib/binary-headers/commands-queue-original.ts` | Pristine copy of master queue (for diff comparison) |

#### Final Codec Interfaces

```typescript
// Outbound codec - transforms commands before sending
interface OutboundCodec {
  transform(
    encoded: ReadonlyArray<RedisArgument>,
    args: ReadonlyArray<RedisArgument>
  ): ReadonlyArray<RedisArgument> | null;  // null = buffered

  drain(): ReadonlyArray<RedisArgument> | null;  // flush buffer

  hasPending(): boolean;  // for timer scheduling
}

// Inbound codec - processes incoming data
interface InboundCodec {
  process(chunk: Buffer, decoder: Decoder): void;
}

// Combined codec
interface CommandCodec {
  readonly outbound: OutboundCodec;
  readonly inbound: InboundCodec;
}
```

#### Queue Integration Points

The codec-queue.ts adds these to the master queue:

```typescript
// Constructor accepts optional codec and timer options
constructor(
  respVersion, maxLength, onShardedChannelMoved,
  codec?: CommandCodec,
  timerOptions?: { maxWaitMs: number; scheduler: Scheduler }
)

// Timer-based flushing
setTimerFlushCallback(callback: TimerFlushCallback): void;
get maxWaitMs(): number;
destroy(): void;

// External flush control
hasPendingOutbound(): boolean;
drainPendingOutbound(): ReadonlyArray<RedisArgument> | null;

// Inbound processing
processIncomingData(chunk: Buffer): void;
```

#### Key Design Decisions

1. **Null check instead of virtual dispatch**: `if (codec !== null)` is nearly free due to branch prediction
2. **No `.bind()`**: Codec methods called directly on the codec object
3. **`T | null` return pattern**: Avoids generator overhead completely
4. **Timer ownership in queue**: Socket layer sets callback, queue manages scheduling
5. **External drain methods**: Allows custom flush strategies

### Benchmark Results

| Scenario | No Codec Overhead | With BinaryHeaders |
|----------|-------------------|-------------------|
| Encode single | 1.3% | 12.4% |
| Decode single | 3.1% | 32.5% |
| Encode batch (10) | 0.7% | 13.5% |
| Decode batch (10) | 1.2% | 6.4% |

**Key finding:** The codec infrastructure has essentially **zero overhead** when no codec is used.

---

## Tools & Scripts

### Run Benchmarks

```bash
cd packages/client
npx ts-node lib/binary-headers/queue-codec-bench.ts
```

### Run Tests

```bash
# From workspace root - supports wildcards
npm run test-single -- "**/codec-queue.spec.ts"
npm run test-single -- "**/packing.spec.ts"
npm run test-single -- "**/interceptor.spec.ts"

# Run all binary-headers tests
npm run test-single -- "**/binary-headers/*.spec.ts"
```

### Compare with Original

```bash
# See what changed from binary-headers branch
git diff binary-headers -- lib/binary-headers/

# See the original codec interface design
git show binary-headers:packages/client/lib/client/commands-queue.ts | head -100
```

### File Structure

```
lib/binary-headers/
├── codec-queue.ts              # Queue with codec support (based on master)
├── commands-queue-original.ts  # Pristine master queue (for diff comparison)
├── codec.ts                    # BinaryHeadersCodec implementation
├── codec-queue.spec.ts         # Tests for codec-queue
├── master-queue.ts             # Performance baseline (copy of master)
├── binhdr-commands-queue.ts    # Original subclass approach
├── packing.ts                  # Command batching logic
├── interceptor.ts              # Inbound header stripping
├── eligibility-resolver.ts     # Command eligibility
├── eligibility-static-data.ts  # Static eligibility data
├── eligibility-types.ts        # Eligibility type definitions
├── queue-codec-bench.ts        # Benchmark tool
├── test-utils.ts               # Test helpers
└── index.ts                    # Module exports
```

### Usage Example

```typescript
import CodecQueue from './codec-queue';
import { BinaryHeadersCodec } from './codec';
import { createTimeoutScheduler } from './packing';
import { STATIC_RESOLVER } from './eligibility-static-data';

// Create codec
const codec = new BinaryHeadersCodec({
  outbound: { resolver: STATIC_RESOLVER, maxWaitMs: 10 },
  inbound: { onProtocolError: (id) => console.error(`Error: ${id}`) }
});

// Create queue with codec and timer
const queue = new CodecQueue(
  2, null, onShardedChannelMoved,
  codec,
  { maxWaitMs: 10, scheduler: createTimeoutScheduler() }
);

// Set flush callback for timer-based flushes
queue.setTimerFlushCallback((data) => socket.write(data));

// Normal usage
queue.addCommand(['SET', 'key', 'value']);
for (const encoded of queue.commandsToWrite()) {
  socket.write(encoded);
}

// Process responses
socket.on('data', (chunk) => queue.processIncomingData(chunk));

// Cleanup
queue.destroy();
```

---

## Reviewer Workflow

To understand how codec support was integrated into the original queue, we maintain a pristine copy of the master queue for easy diffing.

### Reviewing the Codec Integration

The `commands-queue-original.ts` file is an exact copy of `commands-queue.ts` from the master branch. The `codec-queue.ts` file is built on top of it with minimal changes.

**To see exactly what was added for codec support:**

```bash
cd packages/client/lib/binary-headers

# Side-by-side diff
diff -u commands-queue-original.ts codec-queue.ts

# Or with your favorite diff tool
vimdiff commands-queue-original.ts codec-queue.ts
code --diff commands-queue-original.ts codec-queue.ts
```

### What the Diff Shows

The diff reveals ~110 lines of additions and ~8 lines of modifications:

1. **Import changes** - Adjusted paths for `binary-headers/` location + added `Cancellable, Scheduler` types
2. **Codec interfaces** - `OutboundCodec`, `InboundCodec`, `CommandCodec`, `TimerFlushCallback`, `TimerOptions`
3. **New class fields** - `#codec`, `#scheduler`, `#maxWaitMs`, `#pendingFlush`, `#timerFlushCallback`
4. **Extended constructor** - Added `codec?` and `timerOptions?` parameters
5. **Timer methods** - `setTimerFlushCallback`, `maxWaitMs` getter, `destroy`, `#scheduleFlush`, `#cancelPendingFlush`
6. **Modified `commandsToWrite()`** - Codec transform/drain integration
7. **New public methods** - `processIncomingData`, `hasPendingOutbound`, `drainPendingOutbound`

### Keeping Files in Sync

If the master queue changes, update the original:

```bash
git show master:packages/client/lib/client/commands-queue.ts > packages/client/lib/binary-headers/commands-queue-original.ts
```

Then reapply codec changes to `codec-queue.ts` while preserving formatting.

---

## Phase 2: Finalization (Current)

Implementation is **complete**. We now focus on:
1. **Explore** - Is there a better architecture for codec integration?
2. **Simplify** - Remove redundant code, consolidate implementations
3. **Finalize** - Create a clean branch with only the chosen implementation
4. **Document** - Update docs to reflect final architecture

### What We Have Now

Two working implementations that both pass all 158 tests:

| Implementation | Approach | File |
|---------------|----------|------|
| **CodecQueue** | Composition - codec passed to constructor | `codec-queue.ts` |
| **BinhdrCommandsQueue** | Subclass - extends base queue | `binhdr-commands-queue.ts` |

Plus test infrastructure to swap between them (`queue-test-factories.ts`).

### Finalization Tasks

#### 1. Architecture Decision

Questions to answer:

- [ ] **Is CodecQueue the right approach?** Or should we use subclassing?
- [ ] **Can we simplify the codec interface further?**
- [ ] **Is timer integration in the right place?** Should it be in the codec instead?
- [ ] **Should codec be optional or always present?** (null-object pattern vs null check)

#### 2. Code Cleanup

Files to potentially remove after deciding on architecture:

- [ ] `binhdr-commands-queue.ts` - If we choose CodecQueue
- [ ] `commands-queue-original.ts` - Reference file, not needed in final
- [ ] `master-queue.ts` - Benchmark baseline, not needed in final
- [ ] `queue-test-factories.ts` - Simplify once we have one implementation

#### 3. Test Cleanup

- [ ] Remove `getBothImplementations()` tests - only need one implementation
- [ ] Simplify `queue-test-factories.ts` or inline factories
- [ ] Update test descriptions to remove `[codec-queue]` / `[binhdr-subclass]` labels
- [ ] Ensure coverage of final implementation

#### 4. Integration

- [ ] Integrate `codec-queue.ts` changes back into main `commands-queue.ts`
- [ ] Or keep as separate file if that's cleaner
- [ ] Update client to use the new queue with codec support
- [ ] Ensure all existing functionality preserved (PubSub, MONITOR, etc.)

#### 5. Documentation

- [ ] Update this file to be final documentation (not task tracking)
- [ ] Add inline code comments where helpful
- [ ] Update README if needed

### Architectural Options to Explore

#### Option A: Keep CodecQueue Separate

```
lib/client/commands-queue.ts      # Original, unchanged
lib/binary-headers/codec-queue.ts # Extended version with codec
```

**Pros:** No risk to existing code, clear separation
**Cons:** Two queue implementations to maintain

#### Option B: Merge into commands-queue.ts

```
lib/client/commands-queue.ts  # Now supports optional codec
```

**Pros:** Single implementation, codec is just an option
**Cons:** Changes to critical path code

#### Option C: Codec as Wrapper

```typescript
// Codec wraps the queue instead of being injected
const queue = new RedisCommandsQueue(...);
const codecQueue = wrapWithCodec(queue, codec);
```

**Pros:** Zero changes to original queue
**Cons:** May be awkward for timer integration

#### Option D: Middleware/Interceptor Chain

```typescript
const queue = new RedisCommandsQueue(...);
queue.use(binaryHeadersMiddleware);
```

**Pros:** Familiar pattern, extensible
**Cons:** May add overhead, more complex

### File Disposition Guide

```
lib/binary-headers/
├── codec-queue.ts              # ✅ Keep - Main implementation
├── codec.ts                    # ✅ Keep - BinaryHeadersCodec
├── commands-queue-original.ts  # ❓ Remove after finalization
├── master-queue.ts             # ❓ Remove after finalization
├── binhdr-commands-queue.ts    # ❓ Remove if choosing CodecQueue
├── queue-test-factories.ts     # ❓ Simplify after choosing implementation
├── packing.ts                  # ✅ Keep - Command batching
├── interceptor.ts              # ✅ Keep - Inbound processing
├── eligibility-resolver.ts     # ✅ Keep - Command eligibility
├── eligibility-static-data.ts  # ✅ Keep - Static data
├── eligibility-types.ts        # ✅ Keep - Types
├── codec-queue.spec.ts         # ✅ Keep - Simplify dual-impl tests
├── interceptor.spec.ts         # ✅ Keep - Simplify dual-impl tests
├── packing.spec.ts             # ✅ Keep
├── eligibility.spec.ts         # ✅ Keep
├── flyweight.spec.ts           # ✅ Keep
├── abort-timeout.spec.ts       # ✅ Keep
├── test-utils.ts               # ✅ Keep
├── queue-codec-bench.ts        # ✅ Keep - For validation
├── ralph.sh                    # 🔧 Tool - Remove before merge
└── index.ts                    # ✅ Keep - Update exports
```

### Success Criteria for Finalization

1. **Single implementation** - One queue approach chosen and kept
2. **All tests pass** - No regressions
3. **Performance maintained** - <5% overhead without codec
4. **Clean codebase** - No dead code, no duplicate implementations
5. **Clear documentation** - Easy to understand for future maintainers
6. **Ready for PR** - Can be merged to main branch

### Ralph Script for Finalization

Use `ralph.sh` to assist with finalization tasks:

```bash
cd packages/client/lib/binary-headers

# Single iteration - explore and decide
./ralph.sh once

# Multiple iterations - cleanup work
./ralph.sh 5
```

**Note:** The `ralph-progress.txt` file is gitignored - it's a local tracking file only.
Do not attempt to commit it or worry about its git status.