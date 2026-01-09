import type { EligibilityResolver } from './eligibility';

/**
 * Binary headers connection state
 */
export type BinhdrState =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled'; readonly resolver: EligibilityResolver }
  | { readonly state: 'negotiating' };

/**
 * Events that trigger state transitions
 */
export type BinhdrEvent =
  | { readonly type: 'enable'; readonly resolver: EligibilityResolver }
  | { readonly type: 'disable' }
  | { readonly type: 'start_negotiation' }
  | { readonly type: 'negotiation_success'; readonly resolver: EligibilityResolver }
  | { readonly type: 'negotiation_failed' };

/**
 * Pure state transition function
 */
export function transitionState(
  current: BinhdrState,
  event: BinhdrEvent
): BinhdrState {
  switch (event.type) {
    case 'enable':
      return { state: 'enabled', resolver: event.resolver };

    case 'disable':
      return { state: 'disabled' };

    case 'start_negotiation':
      if (current.state === 'disabled') {
        return { state: 'negotiating' };
      }
      return current;

    case 'negotiation_success':
      if (current.state === 'negotiating') {
        return { state: 'enabled', resolver: event.resolver };
      }
      return current;

    case 'negotiation_failed':
      if (current.state === 'negotiating') {
        return { state: 'disabled' };
      }
      return current;

    default:
      return current;
  }
}

/**
 * State machine interface
 */
export interface BinhdrStateMachine {
  getState(): BinhdrState;
  dispatch(event: BinhdrEvent): void;
  isEnabled(): boolean;
}

/**
 * Create a binary headers state machine
 */
export function createBinhdrStateMachine(
  initialState: BinhdrState = { state: 'disabled' }
): BinhdrStateMachine {
  let currentState = initialState;

  return {
    getState() {
      return currentState;
    },

    dispatch(event: BinhdrEvent) {
      currentState = transitionState(currentState, event);
    },

    isEnabled() {
      return currentState.state === 'enabled';
    }
  };
}
