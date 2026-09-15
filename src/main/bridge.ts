import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { BridgeStatus, StreamAudioFrame } from '@shared/stream';
import { BRIDGE_CLIENT_JS, BRIDGE_INDEX_HTML } from './bridge-assets';

/**
 * The browser-source bridge: a local web server that hands Domino's audio
 * analysis to anything that can open a WebSocket.
 *
 * OBS's Browser Source is a Chromium page, and a page cannot hear the
 * desktop - so the visualiser's own analysis is served to it instead. Every
 * frame the renderer produces is pushed to each connected page as one small
 * JSON message, and a page that would rather poll can GET the latest one.
 *
 * The WebSocket side is written out by hand rather than pulled in as a
 * dependency. It only ever sends, the messages are small, and the protocol's
 * server half - one handshake, a length prefix, and answering pings - is a
 * hundred lines. Loopback only: this never listens on an outside interface.
 *
 * Deliberately free of anything Electron, so it runs under plain Node in the
 * tests.
 */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Frames from the page are read but never used, so anything large is hostile. */
const MAX_INBOUND = 64 * 1024;

interface Client {
  socket: Socket;
  /** Bytes received and not yet parsed into a whole frame. */
  pending: Buffer;
  closing: boolean;
}

export class Bridge {
  private server: Server | null = null;
  private clients = new Set<Client>();
  private port = 0;
  private error = '';
  private latest: StreamAudioFrame | null = null;
  private latestJson = 'null';
  /** Called whenever the number of connected pages changes. */
  onClients: ((count: number) => void) | null = null;

  getStatus(): BridgeStatus {
    return {
      running: this.server !== null,
      port: this.port,
      clients: this.clients.size,
      url: this.server ? `http://127.0.0.1:${this.port}/` : '',
      error: this.error,
    };
  }

  /** Listen on the loopback interface. Port 0 asks the OS for a free one. */
  start(port: number): Promise<BridgeStatus> {
    if (this.server) return Promise.resolve(this.getStatus());
    this.error = '';

    return new Promise((resolve) => {
      const server = createServer((req, res) => this.handleHttp(req, res));
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
      server.on('error', (err: NodeJS.ErrnoException) => {
        this.error =
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Pick another, or close whatever has it.`
            : err.message;
        this.server = null;
        this.port = 0;
        resolve(this.getStatus());
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : port;
        this.server = server;
        resolve(this.getStatus());
      });
    });
  }

  stop(): Promise<BridgeStatus> {
    const server = this.server;
    if (!server) return Promise.resolve(this.getStatus());
    this.server = null;
    for (const client of this.clients) this.close(client, 1001);
    this.clients.clear();
    this.onClients?.(0);
    return new Promise((resolve) => {
      server.close(() => {
        this.port = 0;
        resolve(this.getStatus());
      });
    });
  }

  /** Push one frame to every page, and remember it for anyone polling. */
  broadcast(frame: StreamAudioFrame): void {
    this.latest = frame;
    this.latestJson = JSON.stringify(frame);
    if (this.clients.size === 0) return;
    const packet = encodeText(this.latestJson);
    for (const client of this.clients) {
      if (client.closing) continue;
      // A page that has stopped reading would otherwise buffer without bound.
      if (client.socket.writableLength > 256 * 1024) {
        this.close(client, 1008);
        continue;
      }
      client.socket.write(packet);
    }
  }

  /* -------------------------------- http -------------------------------- */

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0];
    // A browser source may be loaded from a file:// page, which counts as a
    // foreign origin to fetch(); the feed is public on this machine anyway.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    switch (url) {
      case '/':
      case '/index.html':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(BRIDGE_INDEX_HTML);
        return;
      case '/domino-audio.js':
        res
          .writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
          .end(BRIDGE_CLIENT_JS);
        return;
      case '/audio.json':
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(this.latestJson);
        return;
      case '/status.json':
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(this.getStatus()));
        return;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  }

  /* ------------------------------ websocket ----------------------------- */

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    const path = (req.url ?? '/').split('?')[0];
    if (
      path !== '/audio' ||
      typeof key !== 'string' ||
      String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket'
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const client: Client = { socket, pending: head.length ? Buffer.from(head) : Buffer.alloc(0), closing: false };
    this.clients.add(client);
    this.onClients?.(this.clients.size);

    socket.on('data', (chunk: Buffer) => this.onData(client, chunk));
    const drop = (): void => {
      if (!this.clients.delete(client)) return;
      this.onClients?.(this.clients.size);
    };
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('end', () => this.close(client, 1000));

    // The latest frame straight away, so a page has something to draw before
    // the next tick rather than a blank first moment.
    if (this.latest) socket.write(encodeText(this.latestJson));
    if (client.pending.length) this.onData(client, Buffer.alloc(0));
  }

  /**
   * Consume whatever the page sends.
   *
   * Nothing a page says changes anything here, but the frames still have to
   * be walked: a close must be answered, a ping must get a pong, and a
   * client-to-server frame is masked, so the length has to be decoded to know
   * where the next one starts.
   */
  private onData(client: Client, chunk: Buffer): void {
    if (client.closing) return;
    client.pending = client.pending.length ? Buffer.concat([client.pending, chunk]) : chunk;

    for (;;) {
      const buf = client.pending;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_INBOUND)) return this.close(client, 1009);
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_INBOUND) return this.close(client, 1009);
      if (!masked) return this.close(client, 1002);
      const total = offset + 4 + length;
      if (buf.length < total) return;

      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, total));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      client.pending = buf.subarray(total);

      switch (opcode) {
        case 0x8: {
          // Echo the status code back, then let the socket end.
          client.closing = true;
          client.socket.end(encodeFrame(0x8, payload.subarray(0, 2)));
          return;
        }
        case 0x9:
          client.socket.write(encodeFrame(0xa, payload));
          break;
        default:
          break; // text, binary, pong, continuation: nothing to do
      }
    }
  }

  private close(client: Client, code: number): void {
    if (client.closing) return;
    client.closing = true;
    const reason = Buffer.alloc(2);
    reason.writeUInt16BE(code);
    client.socket.end(encodeFrame(0x8, reason));
    // A peer that never answers the close would leave the socket half open.
    setTimeout(() => client.socket.destroy(), 1000).unref();
  }
}

/** A single unmasked server frame with the given opcode. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'));
}
