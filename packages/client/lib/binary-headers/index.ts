// Binary Header Protocol Types
export type {
  RequestHeader as BinaryRequestHeader,
} from './generated/request-header-codec';
export type {
  ResponseHeader as BinaryResponseHeader,
} from './generated/response-header-codec';

// Binary Header Encoders/Decoders (generated low-level codecs)
export {
  RequestHeaderEncoder,
  RequestHeaderDecoder,
} from './generated/request-header-codec';

export {
  ResponseHeaderEncoder,
  ResponseHeaderDecoder,
  extractCommandCount,
  hasProtocolError,
} from './generated/response-header-codec';

// Packing
export type {
  Scheduler,
  Cancellable,
} from './packing';

export {
  CommandPacker,
  createTimeoutScheduler,
  createImmediateScheduler,
  calculatePayloadLength,
} from './packing';

// Eligibility
export type {
  EligibilityResult,
  CommandRecord,
  CommandRecordFetcher,
  KeyPosition,
  BlockingBehavior,
  CommandAttrs,
  CommandNode,
} from './eligibility';

export {
  EligibilityResolver,
  NOOP_RESOLVER,
  SLOT_INELIGIBLE,
  STATIC_COMMAND_RECORDS,
  STATIC_RESOLVER,
  createMockRecordFetcher,
  createEligibilityResolver,
} from './eligibility';

// Wire Interceptor interfaces
export type {
  OutboundInterceptor,
  InboundInterceptor,
  WireInterceptor,
  SocketChunk,
  SocketChunks,
  TimerFlushCallback,
  TimerOptions,
} from '../client/commands-queue';

// Binary Headers Interceptor (integrates with commands-queue)
export type {
  OnHeader,
  OnProtocolError,
  BinaryHeadersInterceptorOptions,
  BinaryHeadersOutboundOptions,
  BinaryHeadersInboundOptions,
} from './codec';

export {
  BinaryHeadersInterceptor,
  BinaryHeadersOutboundInterceptor,
  BinaryHeadersInboundInterceptor,
  createBinaryHeadersInterceptor,
} from './codec';
