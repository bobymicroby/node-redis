export type {
  RequestHeader as BinaryRequestHeader,
} from './generated/request-header-codec';
export type {
  ResponseHeader as BinaryResponseHeader,
} from './generated/response-header-codec';

// ═══════════════════════════════════════════════════════════════════════════════
// Flyweight Encoder/Decoder API (SBE-style, zero-allocation)
// ═══════════════════════════════════════════════════════════════════════════════

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

export type {
  OnHeader,
  OnProtocolError,
  InterceptorOptions,
} from './interceptor';

export {
  createBinhdrInterceptor,
  passthroughInbound,
  passthroughOutbound,
  chainInbound,
} from './interceptor';

export type {
  BufferedCommand,
  PackingStrategy,
  PackState,
  Scheduler,
  Cancellable,
  CommandPackerOptions,
} from './packing';

export {
  createDefaultPackingStrategy,
  createTimeBoundedPackingStrategy,
  createTimeoutScheduler,
  createImmediateScheduler,
  calculatePayloadLength,
  createBufferedCommand,
  packCommands,
  PackBufferPool,
  CommandPacker,
} from './packing';

export type {
  EligibilityResult,
  CommandRecord,
  CommandRecordFetcher,
  KeyPosition,
  BlockingBehavior,
  CommandAttrs,
  CommandNode,
} from './eligibility-types';

export { EligibilityResolver } from './eligibility-resolver';

export {
  STATIC_COMMAND_RECORDS,
  STATIC_RESOLVER,
  createMockRecordFetcher,
  createDefaultResolver,
  createDynamicResolver,
} from './eligibility-static-data';

export type {
  OutboundCodecOptions,
  InboundCodecOptions,
  CodecOptions,
  TimeBoundedOptions,
  FlushSink,
  BinhdrCodec,
} from './client-integration';

export {
  createBinhdrOutboundInterceptor,
  createBinhdrInboundInterceptor,
  createBinhdrCodec,
} from './client-integration';
