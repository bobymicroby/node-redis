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
export type { PackSingleCommandResult } from './packing';

export {
  calculatePayloadLength,
  packSingleCommand,
  calculateSlotFromKeys,
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
export { createBinhdrCodec } from './client-integration';
