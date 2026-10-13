/**
 * Minimal protobuf for ESPHome's native API (api.proto): a field decoder that keeps every value by
 * field number, typed readers, and an encoder for the request messages Sunroost sends. Pure functions.
 */

/** Message type ids from ESPHome's api.proto (`option (id) = …`). */
export const MSG = {
  HelloRequest: 1,
  HelloResponse: 2,
  /** AuthenticationRequest/Response in newer api.proto (deprecated; removed from firmware in 2026.1). */
  ConnectRequest: 3,
  ConnectResponse: 4,
  DisconnectRequest: 5,
  DisconnectResponse: 6,
  PingRequest: 7,
  PingResponse: 8,
  DeviceInfoRequest: 9,
  DeviceInfoResponse: 10,
  ListEntitiesRequest: 11,
  ListEntitiesBinarySensorResponse: 12,
  ListEntitiesCoverResponse: 13,
  ListEntitiesFanResponse: 14,
  ListEntitiesLightResponse: 15,
  ListEntitiesSensorResponse: 16,
  ListEntitiesSwitchResponse: 17,
  ListEntitiesTextSensorResponse: 18,
  ListEntitiesDoneResponse: 19,
  SubscribeStatesRequest: 20,
  BinarySensorStateResponse: 21,
  CoverStateResponse: 22,
  FanStateResponse: 23,
  LightStateResponse: 24,
  SensorStateResponse: 25,
  SwitchStateResponse: 26,
  TextSensorStateResponse: 27,
  CoverCommandRequest: 30,
  FanCommandRequest: 31,
  LightCommandRequest: 32,
  SwitchCommandRequest: 33,
  GetTimeRequest: 36,
  GetTimeResponse: 37,
  ListEntitiesClimateResponse: 46,
  ClimateStateResponse: 47,
  ClimateCommandRequest: 48,
  ListEntitiesNumberResponse: 49,
  NumberStateResponse: 50,
  NumberCommandRequest: 51,
  ListEntitiesSelectResponse: 52,
  SelectStateResponse: 53,
  SelectCommandRequest: 54,
  ListEntitiesButtonResponse: 61,
  ButtonCommandRequest: 62,
} as const;

// ---------- Varints ----------

export function encodeVarint(n: number | bigint): Buffer {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Reads a varint; returns the value (as a JS number when it fits, low 53 bits otherwise) and the next offset. */
export function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let v = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('Truncated varint');
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: v, next: i };
    shift += 7n;
    if (shift > 63n) throw new Error('Varint too long');
  }
}

// ---------- Decoding ----------

type Raw = { wire: 0; v: bigint } | { wire: 1; b: Buffer } | { wire: 2; b: Buffer } | { wire: 5; b: Buffer };

/** A decoded message: every value of every field, in order. */
export class Fields {
  readonly raw = new Map<number, Raw[]>();

  static decode(buf: Buffer): Fields {
    const f = new Fields();
    let i = 0;
    while (i < buf.length) {
      const tag = readVarint(buf, i);
      i = tag.next;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      let r: Raw;
      if (wire === 0) {
        const v = readVarint(buf, i);
        i = v.next;
        r = { wire: 0, v: v.value };
      } else if (wire === 1) {
        r = { wire: 1, b: buf.subarray(i, i + 8) };
        i += 8;
      } else if (wire === 2) {
        const len = readVarint(buf, i);
        const start = len.next;
        const end = start + Number(len.value);
        if (end > buf.length) throw new Error('Truncated field');
        r = { wire: 2, b: buf.subarray(start, end) };
        i = end;
      } else if (wire === 5) {
        r = { wire: 5, b: buf.subarray(i, i + 4) };
        i += 4;
      } else {
        throw new Error(`Unsupported wire type ${wire}`);
      }
      if (i > buf.length) throw new Error('Truncated message');
      const list = f.raw.get(field) ?? [];
      list.push(r);
      f.raw.set(field, list);
    }
    return f;
  }

  private last(n: number): Raw | undefined {
    return this.raw.get(n)?.at(-1);
  }

  has(n: number) {
    return this.raw.has(n);
  }

  /** uint32 / enum / int32 (two's complement). */
  int(n: number, dflt = 0): number {
    const r = this.last(n);
    if (!r || r.wire !== 0) return dflt;
    return Number(BigInt.asIntN(32, r.v));
  }

  uint(n: number, dflt = 0): number {
    const r = this.last(n);
    if (!r || r.wire !== 0) return dflt;
    return Number(BigInt.asUintN(32, r.v));
  }

  bool(n: number): boolean {
    const r = this.last(n);
    return !!r && r.wire === 0 && r.v !== 0n;
  }

  str(n: number, dflt = ''): string {
    const r = this.last(n);
    return r && r.wire === 2 ? r.b.toString('utf8') : dflt;
  }

  float(n: number, dflt = 0): number {
    const r = this.last(n);
    return r && r.wire === 5 ? r.b.readFloatLE(0) : dflt;
  }

  fixed32(n: number, dflt = 0): number {
    const r = this.last(n);
    return r && r.wire === 5 ? r.b.readUInt32LE(0) : dflt;
  }

  strs(n: number): string[] {
    return (this.raw.get(n) ?? []).filter((r) => r.wire === 2).map((r) => (r as { b: Buffer }).b.toString('utf8'));
  }

  /** Repeated varints, packed or not. */
  ints(n: number): number[] {
    const out: number[] = [];
    for (const r of this.raw.get(n) ?? []) {
      if (r.wire === 0) out.push(Number(BigInt.asIntN(32, r.v)));
      else if (r.wire === 2) {
        let i = 0;
        while (i < r.b.length) {
          const v = readVarint(r.b, i);
          out.push(Number(BigInt.asIntN(32, v.value)));
          i = v.next;
        }
      }
    }
    return out;
  }
}

// ---------- Encoding ----------

const tag = (field: number, wire: number) => encodeVarint((field << 3) | wire);

/** Builds a message; values left undefined are skipped. */
export class Writer {
  private parts: Buffer[] = [];

  varint(field: number, v: number | bigint | undefined) {
    if (v === undefined) return this;
    this.parts.push(tag(field, 0), encodeVarint(v));
    return this;
  }

  bool(field: number, v: boolean | undefined) {
    return v === undefined ? this : this.varint(field, v ? 1 : 0);
  }

  str(field: number, v: string | undefined) {
    if (v === undefined) return this;
    const b = Buffer.from(v, 'utf8');
    this.parts.push(tag(field, 2), encodeVarint(b.length), b);
    return this;
  }

  fixed32(field: number, v: number | undefined) {
    if (v === undefined) return this;
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.parts.push(tag(field, 5), b);
    return this;
  }

  float(field: number, v: number | undefined) {
    if (v === undefined) return this;
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.parts.push(tag(field, 5), b);
    return this;
  }

  bytes() {
    return Buffer.concat(this.parts);
  }
}

// ---------- Enums ----------

export const CLIMATE_MODES = ['off', 'heat_cool', 'cool', 'heat', 'fan_only', 'dry', 'auto'];
export const CLIMATE_ACTIONS: Record<number, string> = { 0: 'off', 2: 'cooling', 3: 'heating', 4: 'idle', 5: 'drying', 6: 'fan', 7: 'defrosting' };
export const CLIMATE_FAN_MODES = ['on', 'off', 'auto', 'low', 'medium', 'high', 'middle', 'focus', 'diffuse', 'quiet'];
/** ColorMode values with the brightness capability bit. */
export const supportsBrightness = (modes: number[]) => modes.some((m) => (m & 2) !== 0);
