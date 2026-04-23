import encodeCommand, { encodeCommandWithLength } from '../RESP/encoder';
import type { RedisArgument } from '../RESP/types';
import type {
  BufferedCommands,
  OutboundCodec,
  WriteBatch,
} from '../binary-headers/wire-codec';
import type { CommandToWrite } from './commands-queue';

export interface EncodedCommandToWrite {
  encoded: ReadonlyArray<RedisArgument>;
  byteLength: number | undefined;
}

export function encodeCommandToWrite(
  args: ReadonlyArray<RedisArgument>,
  outbound: OutboundCodec | null,
): EncodedCommandToWrite {
  if (outbound !== null) {
    const result = encodeCommandWithLength(args);
    return {
      encoded: result.encoded,
      byteLength: result.byteLength,
    };
  }

  return {
    encoded: encodeCommand(args),
    byteLength: undefined,
  };
}

export function prepareCommandToWaitForReply(
  command: CommandToWrite,
  removeAbortListener: (command: CommandToWrite) => void,
  removeTimeoutListener: (command: CommandToWrite) => void,
): symbol | undefined {
  (command as any).args = undefined;

  if (command.abort) {
    removeAbortListener(command);
    command.abort = undefined;
  }

  if (command.timeout) {
    removeTimeoutListener(command);
    command.timeout = undefined;
  }

  const chainId = command.chainId;
  command.chainId = undefined;
  return chainId;
}

export function rejectBufferedOutbound(
  outbound: OutboundCodec | null,
  err: Error,
  rejectCommand: (command: CommandToWrite, err: Error) => void,
): BufferedCommands {
  const buffered = outbound?.reset() ?? [];
  for (const command of buffered) {
    rejectCommand(command, err);
  }
  return buffered;
}

export function pushCommandToOutbound(
  outbound: OutboundCodec,
  command: CommandToWrite,
  encoded: ReadonlyArray<RedisArgument>,
  byteLength: number | undefined,
): WriteBatch | null {
  return outbound.push(command, encoded, command.args, byteLength, {
    chainId: command.chainId,
    forceImmediate: command.abort !== undefined || command.timeout !== undefined,
  });
}
