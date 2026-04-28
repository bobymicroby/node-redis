import { EventEmitter } from "node:events";
import RespFramer from "./resp-framer";
import { Socket } from "node:net";

interface Request {
  resolve: (data: Buffer) => void;
  reject: (reason: any) => void;
  remaining: number;
  chunks: Buffer[];
}

export default class RespQueue extends EventEmitter {
  queue: Request[] = [];
  respFramer: RespFramer = new RespFramer();

  constructor(private serverSocket: Socket) {
    super();
    this.respFramer.on("message", (msg) => this.handleMessage(msg));
    this.serverSocket.on("data", (data) => this.respFramer.write(data));
  }

  handleMessage(data: Buffer) {
    const request = this.queue[0];
    if (request) {
      request.chunks.push(data);
      request.remaining--;
      if (request.remaining === 0) {
        this.queue.shift();
        request.resolve(Buffer.concat(request.chunks));
      }
    } else {
      this.emit("push", data);
    }
  }

  request(data: Buffer, expectedReplies = 1): Promise<Buffer> {
    let resolve: (data: Buffer) => void;
    let reject: (reason: any) => void;

    const promise = new Promise<Buffer>((rs, rj) => {
      resolve = rs;
      reject = rj;
    });

    //@ts-ignore
    this.queue.push({ resolve, reject, remaining: expectedReplies, chunks: [] });
    this.serverSocket.write(data);
    return promise;
  }
}
