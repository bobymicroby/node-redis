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
  EligibleNode,
  EligibilityResult,
  KeyPositionInfo,
  CommandBinhdrRawReply,
  CommandBinhdrFetcher,
} from './eligibility';

export {
  EligibilityResolver,
  DynamicEligibilityResolverFactory,
  STATIC_BINHDR_RECORDS,
  createMockBinhdrFetcher,
  createDefaultResolver,
} from './eligibility';

// Packing
export type {
  BufferedCommand,
  PackingStrategy,
} from './packing';

export {
  CommandPacker,
  createDefaultPackingStrategy,
  createBufferedCommand,
  calculateCommandSlot,
  calculatePayloadLength,
  packCommands,
} from './packing';

// Interceptor
export type {
  DataHandler,
  DataInterceptor,
  OnBinhdrHeader,
  OnBinhdrProtocolError,
  BinhdrInterceptorOptions,
} from './interceptor';

export { createBinhdrInterceptor } from './interceptor';

// Client integration
export type { BinhdrCodecOptions } from './client-integration';

export { createBinhdrCodec } from './client-integration';
