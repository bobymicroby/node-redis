export { BINHDR } from './constants';
export type { BINHDR as BINHDRType } from './constants';

export type {
  BinaryRequestHeader,
  BinaryResponseHeader,
  CreateRequestHeaderError,
  CreateRequestHeaderResult,
  EncodeRequestHeaderIntoError,
  EncodeRequestHeaderIntoResult,
} from './types';

export {
  createRequestHeader,
  encodeRequestHeader,
  encodeRequestHeaderInto,
  encodeResponseHeader,
} from './encoder';

export type {
  ParseRequestHeaderError,
  ParseRequestHeaderResult,
  ParseResponseHeaderError,
  ParseResponseHeaderResult,
} from './decoder';

export {
  isBinaryHeaderDesignator,
  extractCommandCount,
  hasProtocolError,
  parseRequestHeader,
  parseResponseHeader,
  startsWithBinaryHeader,
} from './decoder';

export type {
  KeyPosition,
  BlockingBehavior,
  CommandAttrs,
  CommandNode,
  CommandRecord,
  CommandRecordFetcher,
  EligibilityResult,
} from './eligibility';

export {
  EligibilityResolver,
  createEligibilityResolver,
  STATIC_COMMAND_RECORDS,
  createMockRecordFetcher,
  createDefaultResolver,
} from './eligibility';

export type {
  BufferedCommand,
  PackingStrategy,
} from './packing';

export {
  CommandPacker,
  createDefaultPackingStrategy,
  createBufferedCommand,
  calculatePayloadLength,
  packCommands,
} from './packing';

export type {
  OnHeader,
  OnProtocolError,
  InterceptorOptions,
} from './interceptor';

export {
  createBinhdrInterceptor,
  chainInbound,
  passthroughInbound,
  passthroughOutbound
} from './interceptor';

export type {
  CodecOptions,
  OutboundCodecOptions,
  InboundCodecOptions,
} from './client-integration';

export {
  createBinhdrCodec,
  createBinhdrOutboundInterceptor,
  createBinhdrInboundInterceptor,
} from './client-integration';
