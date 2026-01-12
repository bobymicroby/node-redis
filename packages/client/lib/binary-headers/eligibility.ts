// Barrel export for eligibility module

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
} from './eligibility-types';

export {
  StaticEligibilityResolver,
  DynamicEligibilityResolverFactory,
} from './eligibility-resolver';

export { checkRuntimeEligibility } from './eligibility-runtime';

export {
  STATIC_BINHDR_RECORDS,
  createMockBinhdrFetcher,
  createDefaultResolver,
} from './eligibility-static-data';
