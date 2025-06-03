import { RequestPolicy } from "../../commands/COMMAND";
import { ShardNode } from "../cluster-slots";
import type { Either } from './types';

export interface CommandRouter {
  routeCommand(
    command: string,
    policy: RequestPolicy,
  ): Either<ShardNode>;
}