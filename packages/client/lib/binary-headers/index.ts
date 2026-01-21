// Re-export from generated files
export { BINHDR } from './generated/constants';
export type { BINHDR as BINHDRType } from './generated/constants';

export type {
  RequestHeader as BinaryRequestHeader,
  ResponseHeader as BinaryResponseHeader,
} from './generated/types';

export type {
  CreateRequestHeaderError,
  CreateRequestHeaderResult,
  EncodeRequestHeaderIntoResult,
} from './generated/encoder';

export {
  createRequestHeader,
  encodeRequestHeader,
  encodeRequestHeaderInto,
  encodeResponseHeader,
} from './generated/encoder';

export type {
  ParseRequestHeaderError,
  ParseRequestHeaderResult,
  ParseResponseHeaderError,
  ParseResponseHeaderResult,
} from './generated/decoder';

export {
  isBinaryHeaderDesignator,
  extractCommandCount,
  hasProtocolError,
  parseRequestHeader,
  parseResponseHeader,
  startsWithBinaryHeader,
} from './generated/decoder';

// Interceptor exports
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

// Packing exports
export type {
  BufferedCommand,
  PackingStrategy,
  PackState,
} from './packing';

export {
  createDefaultPackingStrategy,
  calculatePayloadLength,
  createBufferedCommand,
  packCommands,
  CommandPacker,
} from './packing';

// Eligibility exports
export type {
  EligibilityResult,
  CommandRecord,
} from './eligibility-types';

export { EligibilityResolver } from './eligibility-resolver';

// Client integration exports
export type {
  OutboundCodecOptions,
  InboundCodecOptions,
  CodecOptions,
} from './client-integration';

export {
  createBinhdrOutboundInterceptor,
  createBinhdrInboundInterceptor,
  createBinhdrCodec,
} from './client-integration';
