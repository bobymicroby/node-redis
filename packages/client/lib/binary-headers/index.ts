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
  Either,
  BlockingBehavior,
  CommandBinhdrReply,
  CommandBinhdrNode,
  CommandBinhdrRecords,
  CommandBinhdrRawReply,
  CommandBinhdrFetcher,
  EligibilityResolverError,
  EligibilityResult,
  EligibilityResolver,
  EligibilityReason,
  RuntimeEligibility,
} from './eligibility';

export {
  StaticEligibilityResolver,
  DynamicEligibilityResolverFactory,
  checkRuntimeEligibility,
  STATIC_BINHDR_RECORDS,
  createMockBinhdrFetcher,
  createDefaultResolver,
} from './eligibility';
