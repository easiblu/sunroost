/**
 * Just enough DNS for mDNS service discovery (RFC 6762/6763): build PTR queries and parse the
 * PTR, SRV, TXT and A records devices answer with, including name compression. Pure functions.
 */

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;

export type Record_ =
  | { type: 'PTR'; name: string; ttl: number; target: string }
  | { type: 'SRV'; name: string; ttl: number; target: string; port: number }
  | { type: 'TXT'; name: string; ttl: number; txt: Record<string, string> }
  | { type: 'A'; name: string; ttl: number; ip: string }
  | { type: 'OTHER'; name: string; ttl: number; code: number };

export interface Message {
  id: number;
  response: boolean;
  questions: { name: string; type: number }[];
  records: Record_[];
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error(`DNS label too long: ${p}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

/** A query for the given names (PTR by default); QU bit set so devices may answer by unicast too. */
export function buildQuery(names: string[], type: number = TYPE.PTR): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const qs = names.map((n) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(0x8001, 2); // QU + class IN
    return Buffer.concat([encodeName(n), tail]);
  });
  return Buffer.concat([header, ...qs]);
}

function readName(buf: Buffer, offset: number, depth = 0): { name: string; next: number } {
  if (depth > 20) throw new Error('DNS name pointer loop');
  const labels: string[] = [];
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('DNS name runs past the packet');
    const len = buf[i];
    if (len === 0) return { name: labels.join('.'), next: i + 1 };
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[i + 1];
      const rest = readName(buf, ptr, depth + 1).name;
      return { name: [...labels, rest].filter(Boolean).join('.'), next: i + 2 };
    }
    labels.push(buf.toString('utf8', i + 1, i + 1 + len));
    i += 1 + len;
  }
}

function parseTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const len = data[i];
    const s = data.toString('utf8', i + 1, i + 1 + len);
    i += 1 + len;
    if (!s) continue;
    const eq = s.indexOf('=');
    out[(eq < 0 ? s : s.slice(0, eq)).toLowerCase()] = eq < 0 ? '' : s.slice(eq + 1);
  }
  return out;
}

/** Parses a DNS message; throws on malformed packets (callers drop those). */
export function parse(buf: Buffer): Message {
  if (buf.length < 12) throw new Error('DNS packet too short');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  const questions: Message['questions'] = [];
  for (let q = 0; q < qd; q++) {
    const n = readName(buf, i);
    questions.push({ name: n.name, type: buf.readUInt16BE(n.next) });
    i = n.next + 4;
  }
  const records: Record_[] = [];
  for (let r = 0; r < rrCount && i < buf.length; r++) {
    const n = readName(buf, i);
    const type = buf.readUInt16BE(n.next);
    const ttl = buf.readUInt32BE(n.next + 4);
    const len = buf.readUInt16BE(n.next + 8);
    const start = n.next + 10;
    const data = buf.subarray(start, start + len);
    if (start + len > buf.length) throw new Error('DNS record runs past the packet');
    switch (type) {
      case TYPE.PTR:
        records.push({ type: 'PTR', name: n.name, ttl, target: readName(buf, start).name });
        break;
      case TYPE.SRV:
        records.push({ type: 'SRV', name: n.name, ttl, port: data.readUInt16BE(4), target: readName(buf, start + 6).name });
        break;
      case TYPE.TXT:
        records.push({ type: 'TXT', name: n.name, ttl, txt: parseTxt(data) });
        break;
      case TYPE.A:
        records.push({ type: 'A', name: n.name, ttl, ip: [...data].join('.') });
        break;
      default:
        records.push({ type: 'OTHER', name: n.name, ttl, code: type });
    }
    i = start + len;
  }
  return { id, response: (flags & 0x8000) !== 0, questions, records };
}

/** Builds a response packet (for tests and the simulators): records are written uncompressed. */
export function buildResponse(records: Record_[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  const rr = records.map((r) => {
    let data: Buffer;
    let code: number;
    switch (r.type) {
      case 'PTR':
        code = TYPE.PTR;
        data = encodeName(r.target);
        break;
      case 'SRV': {
        code = TYPE.SRV;
        const head = Buffer.alloc(6);
        head.writeUInt16BE(r.port, 4);
        data = Buffer.concat([head, encodeName(r.target)]);
        break;
      }
      case 'TXT':
        code = TYPE.TXT;
        data = Buffer.concat(Object.entries(r.txt).map(([k, v]) => {
          const b = Buffer.from(`${k}=${v}`);
          return Buffer.concat([Buffer.from([b.length]), b]);
        }));
        break;
      case 'A':
        code = TYPE.A;
        data = Buffer.from(r.ip.split('.').map(Number));
        break;
      default:
        code = r.code;
        data = Buffer.alloc(0);
    }
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(code, 0);
    meta.writeUInt16BE(1, 2);
    meta.writeUInt32BE(r.ttl, 4);
    meta.writeUInt16BE(data.length, 8);
    return Buffer.concat([encodeName(r.name), meta, data]);
  });
  return Buffer.concat([header, ...rr]);
}
