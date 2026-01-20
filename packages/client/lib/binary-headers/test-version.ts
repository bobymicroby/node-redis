import { BINHDR } from './generated/constants';

/**
 * Protocol version detection for conditional test execution.
 *
 * Usage in tests:
 * ```
 * import { describeVersion, itVersion, PROTOCOL_VERSION } from './test-version';
 *
 * describeVersion(1, 'v1-specific tests', () => {
 *   it('tests requestId field', () => { ... });
 * });
 *
 * describeVersion(0, 'v0-specific tests', () => {
 *   it('tests clientIdx field', () => { ... });
 * });
 * ```
 */

type BINHDRKeys = keyof typeof BINHDR;

function hasKey<K extends string>(key: K): key is K & BINHDRKeys {
  return key in BINHDR;
}

/** Current protocol version (0 if VERSION constant not present) */
export const PROTOCOL_VERSION: number = hasKey('VERSION')
  ? (BINHDR as Record<string, number>)['VERSION']
  : 0;

/** Conditional describe that only runs for specified version */
export function describeVersion(version: number, name: string, fn: () => void): void {
  (PROTOCOL_VERSION === version ? describe : describe.skip)(name, fn);
}

/** Conditional it that only runs for specified version */
export function itVersion(version: number, name: string, fn: () => void): void {
  (PROTOCOL_VERSION === version ? it : it.skip)(name, fn);
}

/**
 * Helper to get version-specific constant with type safety.
 * Returns undefined if constant doesn't exist in current version.
 */
export function getConstant(key: string): number | undefined {
  return hasKey(key) ? (BINHDR as Record<string, number>)[key] : undefined;
}
