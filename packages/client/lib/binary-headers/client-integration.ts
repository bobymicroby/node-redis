import type {
  CommandCodec,
  OutboundCommand,
  OutboundInterceptor,
  InboundInterceptor,
} from '../client/commands-queue';
import { EligibilityResolver } from './eligibility-resolver';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import { CommandPacker, createDefaultPackingStrategy, createBufferedCommand } from './packing';
import type { ResponseHeader } from './generated/types';

export interface OutboundCodecOptions {
  readonly resolver?: EligibilityResolver | null;
}

export interface InboundCodecOptions {
  readonly onProtocolError?: (requestId: number) => void;
}

export interface CodecOptions extends OutboundCodecOptions, InboundCodecOptions {}

export function createBinhdrOutboundInterceptor(
  getResolver: () => EligibilityResolver | null,
  packer: CommandPacker = new CommandPacker(createDefaultPackingStrategy())
): OutboundInterceptor {
  return {
    process(command: OutboundCommand): OutboundCommand | null {
      const resolver = getResolver();
      if (!resolver) {
        return command;
      }

      const eligibility = resolver.getEligibility(command.args);
      if (!eligibility.eligible) {
        return command;
      }

      const buffered = createBufferedCommand(command.args, command.encoded, eligibility);
      const packed = packer.add(buffered);
      if (packed === null) {
        return null;
      }
      return { args: command.args, encoded: packed };
    },

    drain(): OutboundCommand | null {
      const packed = packer.drain();
      if (packed === null) {
        return null;
      }
      return { args: [], encoded: packed };
    }
  };
}

export function createBinhdrInboundInterceptor(options: InboundCodecOptions = {}): InboundInterceptor {
  const { onProtocolError } = options;

  return createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header: ResponseHeader) => onProtocolError(header.requestId)
      : undefined,
  });
}

/**
 * Creates a codec for binary headers wire format.
 *
 * Resolver loads asynchronously - commands pass through unpacked until ready.
 * If resolver fails to load, all commands pass through as regular RESP.
 */
export function createBinhdrCodec(options: CodecOptions = {}): CommandCodec {
  const { onProtocolError } = options;

  let resolver: EligibilityResolver | null = null;

  createDefaultResolver()
    .then((r) => { resolver = r; })
    .catch(() => { /* resolver stays null, commands pass through */ });

  const outbound = createBinhdrOutboundInterceptor(() => resolver);
  const inbound = createBinhdrInboundInterceptor({ onProtocolError });

  return {
    outbound,
    inbound,
  };
}
