import encodeCommand from '../RESP/encoder';
import type { RedisArgument } from '../RESP/types';
import type {
  BufferedCommands,
  OutboundCodec,
  WriteBatch,
} from '../binary-headers/wire-codec';
import type { CommandToWrite } from './commands-queue';

export interface EncodedCommandToWrite {
  encoded: ReadonlyArray<RedisArgument>;
}

export function encodeCommandToWrite(
  args: ReadonlyArray<RedisArgument>
): EncodedCommandToWrite {
  return {
    encoded: encodeCommand(args),
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
  encoded: ReadonlyArray<RedisArgument>
): WriteBatch | null {
  return outbound.push(command, encoded);
}
