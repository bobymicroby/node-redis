#!/bin/bash
# ralph.sh - Autonomous AI Coding Loop for Binary Headers Finalization
#
# Based on the "Ralph Wiggum" pattern from https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum
#
# Phase: FINALIZATION - Architecture exploration, cleanup, and preparing final branch
#
# Usage:
#   ./ralph.sh <iterations>           # Run AFK mode with max iterations
#   ./ralph.sh once                   # Run single HITL iteration
#   ./ralph.sh zed                    # Generate prompt for Zed AI (manual loop)
#   ./ralph.sh                        # Show usage
#
# Prerequisites:
#   - Claude Code CLI installed (claude) - OR use 'zed' mode for manual Zed AI
#   - Docker (optional, for sandboxed execution)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PROGRESS_FILE="$SCRIPT_DIR/ralph-progress.txt"
PRD_FILE="$SCRIPT_DIR/REFACTORING_PROMPT.md"

# Configuration
USE_DOCKER="${USE_DOCKER:-0}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  Ralph Wiggum - Binary Headers Finalization${NC}"
  echo -e "${BLUE}  Phase: Architecture Exploration & Cleanup${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
}

print_usage() {
  print_header
  echo ""
  echo "Usage: $0 <iterations|once|zed>"
  echo ""
  echo "Modes:"
  echo "  <number>   Run AFK mode with specified max iterations"
  echo "  once       Run single HITL (human-in-the-loop) iteration"
  echo "  zed        Generate prompt for Zed AI (copy & paste to new session)"
  echo ""
  echo "Environment Variables:"
  echo "  USE_DOCKER=1    Run in Docker sandbox (recommended for AFK)"
  echo "  CLAUDE_CMD      Override claude command (default: claude)"
  echo ""
  echo "Examples:"
  echo "  ./ralph.sh once              # Single iteration, watch and intervene"
  echo "  ./ralph.sh 5                 # 5 iterations AFK"
  echo "  ./ralph.sh zed               # Get prompt for Zed AI"
  echo "  USE_DOCKER=1 ./ralph.sh 10   # 10 iterations in Docker sandbox"
  echo ""
}

init_progress_file() {
  if [ ! -f "$PROGRESS_FILE" ]; then
    echo -e "${YELLOW}Creating progress file...${NC}"
    cat > "$PROGRESS_FILE" << 'EOF'
# Ralph Progress Log - Finalization Phase
# Delete this file to start fresh.

## Session Started
- Phase: Finalization
- Goal: Clean up, simplify, prepare final branch

## Current State
- CodecQueue implementation: complete, tested
- BinhdrCommandsQueue implementation: complete, tested (candidate for removal)
- All 158 unit tests passing
- Both implementations verified equivalent

## Architecture Decision
- Chosen approach: (to be decided)
- Rationale: (to be documented)

## Cleanup Progress
- [ ] Remove unused implementation
- [ ] Simplify test factories
- [ ] Remove reference files (commands-queue-original.ts, master-queue.ts)
- [ ] Update tests to remove dual-implementation support
- [ ] Clean up imports and exports

## Files Removed
(none yet)

## Files Modified
(none yet)

## Blockers / Questions
(none yet)
EOF
    echo "$(date): Progress file initialized" >> "$PROGRESS_FILE"
  fi
}

build_prompt() {
  cat << 'PROMPT_END'
You are working on FINALIZING the node-redis Binary Headers implementation.

## Context Files
@REFACTORING_PROMPT.md - Full context. See "Phase 2: Finalization (Current)" section for tasks.
@ralph-progress.txt - Progress from previous iterations

## Phase: FINALIZATION (Phase 2 in REFACTORING_PROMPT.md)

Implementation is COMPLETE. Your focus is now:
1. Architecture exploration - is the current design optimal?
2. Code cleanup - remove redundant implementations
3. Test simplification - remove dual-implementation testing
4. Prepare for merge - clean, single implementation

## Your Task

1. **Read Progress File**
   - What's been decided?
   - What's been cleaned up?
   - What remains?

2. **Choose ONE Task** (priority order)

   **If no architecture decision made yet:**
   a. Analyze both implementations (CodecQueue vs BinhdrCommandsQueue)
   b. Run benchmarks: `npx ts-node lib/binary-headers/queue-codec-bench.ts`
   c. Compare complexity, maintainability, integration ease
   d. Document recommendation in progress file

   **If architecture decided, cleanup tasks:**
   a. Remove the unchosen implementation file
   b. Simplify queue-test-factories.ts (remove dual-impl support)
   c. Update tests to use single implementation directly
   d. Remove reference files (commands-queue-original.ts, master-queue.ts)
   e. Clean up any dead imports/exports
   f. Update REFACTORING_PROMPT.md to be final documentation

3. **Before Making Changes**
   - Run tests: `npm run test-single -- "**/binary-headers/*.spec.ts" --ignore "**/enterprise.integration.spec.ts"`
   - Ensure all 158 tests pass

4. **After Making Changes**
   - Run tests again - must still pass
   - Update progress file with what you did
   - Commit: `git commit -m "binary-headers: <what changed>"`

5. **Update Progress**
   Append to ralph-progress.txt:
   - Task completed
   - Files changed/removed
   - Test count (should stay at 158 or decrease if removing redundant tests)
   - Any decisions made

## Completion Signal

Output <promise>COMPLETE</promise> when ALL of these are true:
- Architecture decision documented
- Only one queue implementation remains
- No reference/baseline files remain
- Tests simplified (no dual-implementation tests)
- All tests pass
- No dead code

## Key Files

**Keep:**
- codec-queue.ts OR binhdr-commands-queue.ts (not both)
- codec.ts, packing.ts, interceptor.ts
- eligibility-*.ts files
- All component spec files

**Remove (after decision):**
- The unchosen queue implementation
- commands-queue-original.ts (reference only)
- master-queue.ts (benchmark baseline only)
- Dual-implementation test code in queue-test-factories.ts

## Constraints

- Work in: packages/client/lib/binary-headers/
- Do NOT break existing tests
- Do NOT remove files without updating imports
- Commit after each logical change
- ONE task per iteration

ONLY WORK ON A SINGLE TASK PER ITERATION.
PROMPT_END
}

build_zed_prompt() {
  # Read current progress to show status
  local progress_status=""
  if [ -f "$PROGRESS_FILE" ]; then
    # Extract the cleanup checklist status
    progress_status=$(grep -A 10 "## Cleanup Progress" "$PROGRESS_FILE" 2>/dev/null | head -10 || echo "")
  fi

  cat << 'ZED_PROMPT_END'
I'm running the "Ralph Wiggum" autonomous coding loop manually through Zed AI instead of the `claude` CLI.

**Context:** Binary Headers finalization for node-redis. See:
- `packages/client/lib/binary-headers/REFACTORING_PROMPT.md` - Full context (Phase 2: Finalization)
- `packages/client/lib/binary-headers/ralph-progress.txt` - Progress from previous iterations

**Your Task (ONE task per iteration):**

1. Read `ralph-progress.txt` to see what's been done
2. Pick the next uncompleted task from the cleanup checklist
3. Before changes: Run tests to ensure they pass
   ```
   npm run test-single -- "packages/client/lib/binary-headers/*.spec.ts" --ignore "**/enterprise.integration.spec.ts"
   ```
4. Make the change (remove file, update imports, simplify code)
5. After changes: Run tests again - must still pass
6. Update `ralph-progress.txt` with what you did
7. Commit: `git commit -m "binary-headers: <what changed>"`

**Cleanup Tasks (in order):**
- [ ] Architecture decision (choose CodecQueue or BinhdrCommandsQueue)
- [ ] Remove the unchosen implementation
- [ ] Simplify `queue-test-factories.ts` (remove dual-impl support)
- [ ] Remove `commands-queue-original.ts`
- [ ] Remove `master-queue.ts`
- [ ] Clean up imports/exports in `index.ts`
- [ ] Update tests to remove dual-implementation labels

**Completion Signal:** Output `<promise>COMPLETE</promise>` when ALL cleanup is done and tests pass.

**Constraints:**
- ONE task per iteration
- Do NOT break tests
- Commit after each logical change
ZED_PROMPT_END
}

run_zed_mode() {
  print_header
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  ZED AI MODE - Copy the prompt below into a new Zed AI session${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""

  init_progress_file

  # Show current progress summary
  if [ -f "$PROGRESS_FILE" ]; then
    echo -e "${YELLOW}Current Progress:${NC}"
    grep -A 20 "## Cleanup Progress" "$PROGRESS_FILE" 2>/dev/null | head -10 || true
    echo ""
  fi

  echo -e "${GREEN}─────────────────── COPY BELOW THIS LINE ───────────────────${NC}"
  echo ""
  build_zed_prompt
  echo ""
  echo -e "${GREEN}─────────────────── COPY ABOVE THIS LINE ───────────────────${NC}"
  echo ""
  echo -e "${YELLOW}Instructions:${NC}"
  echo "  1. Copy the prompt above"
  echo "  2. Open a new Zed AI session (Cmd+Shift+P → 'assistant: new context')"
  echo "  3. Paste the prompt"
  echo "  4. Let the AI complete ONE task"
  echo "  5. Run './ralph.sh zed' again for the next iteration"
  echo ""
}

run_claude() {
  local prompt="$1"

  if [ "$USE_DOCKER" = "1" ]; then
    echo -e "${YELLOW}Running in Docker sandbox...${NC}"
    docker run --rm -v "$PROJECT_ROOT:/workspace" -w /workspace/packages/client \
      claude -p "$prompt"
  else
    echo -e "${YELLOW}Running Claude Code...${NC}"
    cd "$PROJECT_ROOT/packages/client"
    $CLAUDE_CMD -p "$prompt"
  fi
}

run_iteration() {
  local iteration="$1"
  local max="$2"

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Iteration $iteration of $max${NC}"
  echo -e "${GREEN}  $(date)${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  local prompt=$(build_prompt)
  local result=$(run_claude "$prompt")

  echo "$result"

  # Check for completion signal
  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  🎉 FINALIZATION COMPLETE!${NC}"
    echo -e "${GREEN}  Ready for final review and PR.${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    return 0
  fi

  return 1
}

main() {
  if [ -z "$1" ]; then
    print_usage
    exit 1
  fi

  # Handle zed mode
  if [ "$1" = "zed" ]; then
    run_zed_mode
    exit 0
  fi

  print_header

  # Check prerequisites (only for non-zed modes)
  if ! command -v $CLAUDE_CMD &> /dev/null; then
    echo -e "${RED}Error: Claude Code CLI not found ($CLAUDE_CMD)${NC}"
    echo "Install it or set CLAUDE_CMD environment variable"
    echo ""
    echo -e "${YELLOW}Tip: Use './ralph.sh zed' for manual Zed AI mode${NC}"
    exit 1
  fi

  if [ ! -f "$PRD_FILE" ]; then
    echo -e "${RED}Error: PRD file not found: $PRD_FILE${NC}"
    exit 1
  fi

  init_progress_file

  if [ "$1" = "once" ]; then
    # HITL mode - single iteration
    echo -e "${BLUE}Mode: HITL (Human-in-the-loop)${NC}"
    echo -e "${BLUE}Running single iteration...${NC}"
    run_iteration 1 1 || true
    echo ""
    echo -e "${YELLOW}HITL iteration complete. Review changes and run again if needed.${NC}"
  else
    # AFK mode - loop with max iterations
    local max_iterations="$1"
    if ! [[ "$max_iterations" =~ ^[0-9]+$ ]]; then
      echo -e "${RED}Error: Invalid iteration count: $max_iterations${NC}"
      print_usage
      exit 1
    fi

    echo -e "${BLUE}Mode: AFK (Away from keyboard)${NC}"
    echo -e "${BLUE}Max iterations: $max_iterations${NC}"

    if [ "$USE_DOCKER" = "1" ]; then
      echo -e "${GREEN}Docker sandbox: ENABLED${NC}"
    else
      echo -e "${YELLOW}Docker sandbox: DISABLED (set USE_DOCKER=1 for safety)${NC}"
    fi

    echo ""
    echo -e "${YELLOW}Starting in 3 seconds... (Ctrl+C to cancel)${NC}"
    sleep 3

    for ((i=1; i<=max_iterations; i++)); do
      if run_iteration "$i" "$max_iterations"; then
        exit 0
      fi

      if [ "$i" -lt "$max_iterations" ]; then
        echo ""
        echo -e "${BLUE}Pausing 5 seconds before next iteration...${NC}"
        sleep 5
      fi
    done

    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  Max iterations ($max_iterations) reached.${NC}"
    echo -e "${YELLOW}  Review progress in: $PROGRESS_FILE${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
  fi
}

main "$@"
