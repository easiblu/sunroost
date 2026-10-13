/**
 * TLS terminator: an HTTPS server that reverse-proxies every request (and WebSocket upgrade) to the
 * main app on 127.0.0.1:<http port>, adding X-Forwarded-For/Proto/Host. The app trusts forwarded
 * headers from loopback only, so req.ip / req.protocol are the real client's.
 */
import { request, type IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface TlsPair {
  key: string | Buffer;
  cert: string | Buffer;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']);

const clientIp = (sock: Socket) => (sock.remoteAddress ?? '').replace(/^::ffff:/i, '');

/**
 * Request headers for the upstream as a raw [name, value, ...] list. Client-supplied X-Forwarded-*
 * headers are replaced, never appended, so a visitor can't pose as a LAN address.
 */
export function forwardHeaders(req: IncomingMessage, keepUpgrade = false): string[] {
  const out: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (HOP.has(name) && !(keepUpgrade && (name === 'connection' || name === 'upgrade'))) continue;
    out.push(raw[i], raw[i + 1]);
  }
  out.push('X-Forwarded-For', clientIp(req.socket), 'X-Forwarded-Proto', 'https');
  if (req.headers.host) out.push('X-Forwarded-Host', req.headers.host);
  return out;
}

export function createHttpsProxy(tls: TlsPair, targetPort: number, targetHost = '127.0.0.1'): Server {
  const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const upstream = request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers: forwardHeaders(req) as unknown as Record<string, string> },
      (up) => {
        const headers: string[] = [];
        for (let i = 0; i < up.rawHeaders.length; i += 2) {
          const name = up.rawHeaders[i].toLowerCase();
          if (name !== 'connection' && name !== 'keep-alive' && name !== 'transfer-encoding') headers.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Sunroost is not responding.');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const up = connect(targetPort, targetHost, () => {
      const h = forwardHeaders(req, true);
      let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < h.length; i += 2) text += `${h[i]}: ${h[i + 1]}\r\n`;
      up.write(text + '\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });

  // A TLS handshake from a scanner shouldn't surface as an unhandled error.
  server.on('tlsClientError', () => {});
  server.on('clientError', (_err, socket) => socket.destroy());
  return server;
}

/** Listens, resolving when bound or rejecting with the bind error (EADDRINUSE, EACCES for < 1024). */
export function listen(server: Server, port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}
