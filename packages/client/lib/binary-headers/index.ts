// Binary Header Protocol Types
export type {
  RequestHeader as BinaryRequestHeader,
} from './generated/request-header-codec';
export type {
  ResponseHeader as BinaryResponseHeader,
} from './generated/response-header-codec';

// Binary Header Encoders/Decoders
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

// Inbound Decoder
export type {
  OnHeader,
  OnProtocolError,
  InboundDecoderOptions,
  PayloadSink,
} from './codec';

export {
  BinhdrInboundDecoder,
} from './codec';

/** @deprecated Use InboundDecoderOptions instead */
export type { InboundDecoderOptions as InterceptorOptions } from './codec';

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
} from './eligibility-types';

export {
  EligibilityResolver,
  NOOP_RESOLVER,
  SLOT_INELIGIBLE,
} from './eligibility-resolver';

export {
  STATIC_COMMAND_RECORDS,
  STATIC_RESOLVER,
  createMockRecordFetcher,
  createDefaultResolver,
  createDynamicResolver,
} from './eligibility-static-data';

// Codec (integrates with commands-queue)
export type {
  TimerFlushCallback,
  TimerOptions,
  CommandCodec,
  OutboundCodec,
  InboundCodec,
} from '../client/commands-queue';

export {
  BinaryHeadersCodec,
  BinaryHeadersOutboundCodec,
  BinaryHeadersInboundCodec,
  createBinaryHeadersCodec,
} from './codec';

export type {
  BinaryHeadersCodecOptions,
  BinaryHeadersOutboundOptions,
  BinaryHeadersInboundOptions,
} from './codec';
