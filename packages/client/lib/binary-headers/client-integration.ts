import type { RedisArgument } from '../RESP/types';
import type { CommandCodec } from '../client/commands-queue';
import { EligibilityResolver } from './eligibility-resolver';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import {
  CommandPacker,
  createDefaultPackingStrategy,
  createBufferedCommand,
} from './packing';

export interface BinhdrCodecOptions {
  readonly onProtocolError?: (clientIdx: number) => void;
}

export function createBinhdrCodec(options: BinhdrCodecOptions = {}): CommandCodec {
  const { onProtocolError } = options;

  let resolver: EligibilityResolver | null = null;

  createDefaultResolver()
    .then(r => { resolver = r; })
    .catch(() => { /* resolver stays null, all commands pass through */ });

  const packer = new CommandPacker(createDefaultPackingStrategy());

  const interceptor = createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header) => onProtocolError(header.clientIdx)
      : undefined
  });

  return {
    encode(
      command: ReadonlyArray<RedisArgument>,
      resp: ReadonlyArray<RedisArgument>
    ): ReadonlyArray<RedisArgument> | null {
      if (!resolver) return resp;

      const eligibility = resolver.getEligibility(command);
      if (!eligibility.eligible) return resp;

      const buffered = createBufferedCommand(command, resp, eligibility);
      return packer.add(buffered);
    },

    flush(): ReadonlyArray<RedisArgument> | null {
      return packer.flush();
    },

    decode(chunk: Buffer, push: (data: Buffer) => void): void {
      interceptor(chunk, push);
    }
  };
}
