/**
 * A safe subset of Home Assistant's Jinja templates, enough for MQTT discovery payloads
 * (Tasmota, ESPHome, Zigbee2MQTT, OpenBeken):
 *
 *   {{ value_json.ENERGY.Power }}   {{ value_json['state'] | lower }}   {{ (value | float * 10) | round(1) }}
 *   {{ 'ON' if value_json.state == 'on' else 'OFF' }}
 *   {% if value_json.contact %}closed{% else %}open{% endif %}
 *
 * Supported: literals, variables, attribute/index access, arithmetic, comparisons, and/or/not, `in`,
 * inline if, `is defined|none|number|string`, {% if/elif/else %}, whitespace control, common filters
 * and int()/float()/round()/min()/max()/bool(), dict .get(). Anything else is a TemplateError, never
 * code execution. Output follows Python's str(): True/False/None.
 */

export class TemplateError extends Error {}

const UNDEFINED = Symbol('undefined');
type V = unknown;

// ---------- Tokenizer (expressions) ----------

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string };

const OPS = ['==', '!=', '<=', '>=', '//', '<', '>', '=', '+', '-', '*', '/', '%', '~', '|', '.', ',', '(', ')', '[', ']', ':', '{', '}'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[++i];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new TemplateError('Unterminated string');
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TemplateError(`Unexpected "${c}"`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

// ---------- Parser → closures ----------

type Scope = Record<string, V>;
type Expr = (s: Scope) => V;

class Parser {
  private i = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  parse(): Expr {
    const e = this.conditional();
    if (this.i < this.toks.length) throw new TemplateError(`Unexpected "${(this.toks[this.i] as { v: unknown }).v}"`);
    return e;
  }

  private peek(t: Tok['t'], v?: string) {
    const k = this.toks[this.i];
    return !!k && k.t === t && (v === undefined || k.v === v);
  }
  private eat(t: Tok['t'], v?: string) {
    if (!this.peek(t, v)) return false;
    this.i++;
    return true;
  }
  private expect(t: Tok['t'], v?: string): Tok {
    const k = this.toks[this.i];
    if (!this.peek(t, v)) throw new TemplateError(`Expected ${v ?? t}${k ? ` before "${k.v}"` : ' at end'}`);
    this.i++;
    return k;
  }

  private conditional(): Expr {
    const a = this.or();
    if (this.eat('name', 'if')) {
      const cond = this.or();
      const b: Expr = this.eat('name', 'else') ? this.conditional() : () => UNDEFINED;
      return (s) => (truthy(cond(s)) ? a(s) : b(s));
    }
    return a;
  }
  private or(): Expr {
    let a = this.and();
    while (this.eat('name', 'or')) {
      const l = a;
      const r = this.and();
      a = (s) => (truthy(l(s)) ? l(s) : r(s));
    }
    return a;
  }
  private and(): Expr {
    let a = this.not();
    while (this.eat('name', 'and')) {
      const l = a;
      const r = this.not();
      a = (s) => (truthy(l(s)) ? r(s) : l(s));
    }
    return a;
  }
  private not(): Expr {
    if (this.eat('name', 'not')) {
      const e = this.not();
      return (s) => !truthy(e(s));
    }
    return this.comparison();
  }
  private comparison(): Expr {
    let a = this.additive();
    for (;;) {
      const k = this.toks[this.i];
      if (k?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(k.v)) {
        this.i++;
        const l = a;
        const r = this.additive();
        const op = k.v;
        a = (s) => compare(op, l(s), r(s));
      } else if (this.peek('name', 'in') || (this.peek('name', 'not') && this.toks[this.i + 1]?.v === 'in')) {
        const neg = this.eat('name', 'not');
        this.expect('name', 'in');
        const l = a;
        const r = this.additive();
        a = (s) => contains(r(s), l(s)) !== neg;
      } else if (this.eat('name', 'is')) {
        const neg = this.eat('name', 'not');
        const test = (this.expect('name') as { v: string }).v;
        const l = a;
        a = (s) => isTest(test, l(s)) !== neg;
      } else return a;
    }
  }
  private additive(): Expr {
    let a = this.mult();
    for (;;) {
      const k = this.toks[this.i];
      if (k?.t !== 'op' || !['+', '-', '~'].includes(k.v)) return a;
      this.i++;
      const l = a;
      const r = this.mult();
      const op = k.v;
      a = (s) => arith(op, l(s), r(s));
    }
  }
  private mult(): Expr {
    let a = this.unary();
    for (;;) {
      const k = this.toks[this.i];
      if (k?.t !== 'op' || !['*', '/', '//', '%'].includes(k.v)) return a;
      this.i++;
      const l = a;
      const r = this.unary();
      const op = k.v;
      a = (s) => arith(op, l(s), r(s));
    }
  }
  private unary(): Expr {
    if (this.eat('op', '-')) {
      const e = this.unary();
      return (s) => -num(e(s));
    }
    return this.postfix();
  }
  private args(): Expr[] {
    const list: Expr[] = [];
    if (this.eat('op', ')')) return list;
    do {
      // Keyword arguments (default=0) are accepted and passed positionally.
      if (this.peek('name') && this.toks[this.i + 1]?.t === 'op' && this.toks[this.i + 1].v === '=') this.i += 2;
      list.push(this.conditional());
    } while (this.eat('op', ','));
    this.expect('op', ')');
    return list;
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eat('op', '.')) {
        const name = (this.expect('name') as { v: string }).v;
        if (this.eat('op', '(')) {
          const target = e;
          const args = this.args();
          e = (s) => callMethod(target(s), name, args.map((a) => a(s)));
        } else {
          const target = e;
          e = (s) => member(target(s), name);
        }
      } else if (this.eat('op', '[')) {
        const target = e;
        const idx = this.conditional();
        this.expect('op', ']');
        e = (s) => member(target(s), idx(s));
      } else if (this.eat('op', '|')) {
        const name = (this.expect('name') as { v: string }).v;
        const args = this.eat('op', '(') ? this.args() : [];
        const target = e;
        e = (s) => applyFilter(name, target(s), args.map((a) => a(s)));
      } else return e;
    }
  }
  private primary(): Expr {
    const k = this.toks[this.i++];
    if (!k) throw new TemplateError('Unexpected end of expression');
    if (k.t === 'num' || k.t === 'str') return () => k.v;
    if (k.t === 'name') {
      const lit: Record<string, V> = { true: true, True: true, false: false, False: false, none: null, None: null };
      if (k.v in lit) return () => lit[k.v];
      if (this.eat('op', '(')) {
        const args = this.args();
        return (s) => applyFilter(k.v, args[0]?.(s), args.slice(1).map((a) => a(s)));
      }
      return (s) => (k.v in s ? s[k.v] : UNDEFINED);
    }
    if (k.v === '(') {
      const e = this.conditional();
      this.expect('op', ')');
      return e;
    }
    if (k.v === '[') {
      const items: Expr[] = [];
      if (!this.eat('op', ']')) {
        do items.push(this.conditional());
        while (this.eat('op', ','));
        this.expect('op', ']');
      }
      return (s) => items.map((x) => x(s));
    }
    throw new TemplateError(`Unexpected "${k.v}"`);
  }
}

// ---------- Semantics ----------

function truthy(v: V) {
  if (v === UNDEFINED || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

function num(v: V): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (Number.isNaN(n)) throw new TemplateError(`Not a number: ${pyStr(v)}`);
  return n;
}

function arith(op: string, a: V, b: V): V {
  if (op === '~') return pyStr(a) + pyStr(b);
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  const x = num(a);
  const y = num(b);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/':
      if (y === 0) throw new TemplateError('Division by zero');
      return x / y;
    case '//':
      if (y === 0) throw new TemplateError('Division by zero');
      return Math.floor(x / y);
    default:
      return ((x % y) + y) % y;
  }
}

function compare(op: string, a: V, b: V): boolean {
  if (op === '==') return equal(a, b);
  if (op === '!=') return !equal(a, b);
  if (a === UNDEFINED || b === UNDEFINED || a === null || b === null) throw new TemplateError('Cannot compare with an undefined value');
  const both = typeof a === 'string' && typeof b === 'string';
  const x = both ? a : num(a);
  const y = both ? b : num(b);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

function equal(a: V, b: V): boolean {
  if ((typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean')) return Number(a) === Number(b);
  return a === b;
}

function contains(container: V, item: V): boolean {
  if (typeof container === 'string') return container.includes(pyStr(item));
  if (Array.isArray(container)) return container.some((x) => equal(x, item));
  if (container && typeof container === 'object') return Object.hasOwn(container, pyStr(item));
  return false;
}

function isTest(test: string, v: V): boolean {
  switch (test) {
    case 'defined': return v !== UNDEFINED;
    case 'undefined': return v === UNDEFINED;
    case 'none': return v === null;
    case 'number': return typeof v === 'number';
    case 'string': return typeof v === 'string';
    case 'mapping': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: throw new TemplateError(`Unknown test "${test}"`);
  }
}

function member(target: V, key: V): V {
  if (target === UNDEFINED || target === null || typeof target !== 'object') return UNDEFINED;
  if (Array.isArray(target) && typeof key === 'number') return target[key < 0 ? target.length + key : key] ?? UNDEFINED;
  const k = String(key);
  return Object.hasOwn(target, k) ? (target as Record<string, V>)[k] : UNDEFINED;
}

function callMethod(target: V, name: string, args: V[]): V {
  if (name === 'get' && target && typeof target === 'object' && !Array.isArray(target)) {
    const v = member(target, args[0]);
    return v === UNDEFINED ? (args.length > 1 ? args[1] : null) : v;
  }
  if (typeof target === 'string') {
    if (name === 'lower') return target.toLowerCase();
    if (name === 'upper') return target.toUpperCase();
    if (name === 'strip') return target.trim();
    if (name === 'startswith') return target.startsWith(pyStr(args[0]));
    if (name === 'endswith') return target.endsWith(pyStr(args[0]));
    if (name === 'split') return args.length ? target.split(pyStr(args[0])) : target.trim().split(/\s+/);
    if (name === 'replace') return target.split(pyStr(args[0])).join(pyStr(args[1]));
  }
  throw new TemplateError(`Unsupported method .${name}()`);
}

function toNumber(v: V, dflt: V, int: boolean): V {
  try {
    const n = num(v);
    return int ? Math.trunc(n) : n;
  } catch {
    if (dflt !== undefined) return dflt;
    throw new TemplateError(`Cannot convert ${pyStr(v)} to a number`);
  }
}

function applyFilter(name: string, v: V, args: V[]): V {
  switch (name) {
    case 'int': return toNumber(v, args[0], true);
    case 'float': return toNumber(v, args[0], false);
    case 'round': {
      const digits = args.length ? num(args[0]) : 0;
      const method = args[1] ?? 'common';
      const f = 10 ** digits;
      const x = num(v) * f;
      const r = method === 'floor' ? Math.floor(x) : method === 'ceil' ? Math.ceil(x) : Math.round(x);
      return r / f;
    }
    case 'abs': return Math.abs(num(v));
    case 'bool': return typeof v === 'string' ? ['true', 'on', 'yes', '1', 'enable'].includes(v.toLowerCase()) : truthy(v);
    case 'lower': return pyStr(v).toLowerCase();
    case 'upper': return pyStr(v).toUpperCase();
    case 'title': return pyStr(v).replace(/\b\w/g, (c) => c.toUpperCase());
    case 'capitalize': return pyStr(v).charAt(0).toUpperCase() + pyStr(v).slice(1).toLowerCase();
    case 'trim': return pyStr(v).trim();
    case 'string': return pyStr(v);
    case 'length':
    case 'count': return typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
    case 'replace': return pyStr(v).split(pyStr(args[0])).join(pyStr(args[1]));
    case 'default':
    case 'd': return v === UNDEFINED || (args[1] === true && !truthy(v)) ? args[0] : v;
    case 'is_defined':
      if (v === UNDEFINED) throw new TemplateError('Value is undefined');
      return v;
    case 'multiply': return num(v) * num(args[0]);
    case 'min': return Array.isArray(v) ? Math.min(...v.map(num)) : Math.min(num(v), ...args.map(num));
    case 'max': return Array.isArray(v) ? Math.max(...v.map(num)) : Math.max(num(v), ...args.map(num));
    case 'tojson':
    case 'to_json': return JSON.stringify(v === UNDEFINED ? null : v);
    case 'from_json':
      try {
        return JSON.parse(pyStr(v));
      } catch {
        throw new TemplateError('Invalid JSON');
      }
    case 'first': return Array.isArray(v) ? (v[0] ?? UNDEFINED) : typeof v === 'string' ? v[0] ?? UNDEFINED : UNDEFINED;
    case 'last': return Array.isArray(v) ? (v.at(-1) ?? UNDEFINED) : typeof v === 'string' ? v.at(-1) ?? UNDEFINED : UNDEFINED;
    default: throw new TemplateError(`Unsupported filter "${name}"`);
  }
}

/** Python's str(): True/False/None, '' for undefined, JSON for containers. */
export function pyStr(v: V): string {
  if (v === UNDEFINED) return '';
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------- Template text: {{ }}, {% if %}, whitespace control ----------

type Node = { kind: 'text'; text: string } | { kind: 'expr'; e: Expr } | { kind: 'if'; branches: { cond: Expr | null; body: Node[] }[] };

function parseNodes(src: string): Node[] {
  const re = /\{\{(-?)([\s\S]*?)(-?)\}\}|\{%(-?)\s*([\s\S]*?)\s*(-?)%\}/g;
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: 'if' }>; body: Node[] }[] = [];
  let body = root;
  let last = 0;
  let trimNext = false;
  for (let m; (m = re.exec(src)); ) {
    let text = src.slice(last, m.index);
    if (trimNext) text = text.replace(/^\s+/, '');
    if (m[1] === '-' || m[4] === '-') text = text.replace(/\s+$/, '');
    if (text) body.push({ kind: 'text', text });
    trimNext = m[3] === '-' || m[6] === '-';
    last = re.lastIndex;
    if (m[2] !== undefined) {
      body.push({ kind: 'expr', e: new Parser(tokenize(m[2])).parse() });
      continue;
    }
    const stmt = m[5];
    const [, word, rest] = /^(\w+)\s*([\s\S]*)$/.exec(stmt) ?? [];
    if (word === 'if') {
      const node: Extract<Node, { kind: 'if' }> = { kind: 'if', branches: [{ cond: new Parser(tokenize(rest)).parse(), body: [] }] };
      body.push(node);
      stack.push({ node, body });
      body = node.branches[0].body;
    } else if (word === 'elif' || word === 'else') {
      const top = stack.at(-1);
      if (!top) throw new TemplateError(`{% ${word} %} without {% if %}`);
      const branch = { cond: word === 'elif' ? new Parser(tokenize(rest)).parse() : null, body: [] as Node[] };
      top.node.branches.push(branch);
      body = branch.body;
    } else if (word === 'endif') {
      const top = stack.pop();
      if (!top) throw new TemplateError('{% endif %} without {% if %}');
      body = top.body;
    } else {
      throw new TemplateError(`Unsupported statement {% ${word ?? stmt} %}`);
    }
  }
  if (stack.length) throw new TemplateError('Missing {% endif %}');
  let text = src.slice(last);
  if (trimNext) text = text.replace(/^\s+/, '');
  if (text) body.push({ kind: 'text', text });
  return root;
}

function render(nodes: Node[], scope: Scope): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'expr') out += pyStr(n.e(scope));
    else {
      const b = n.branches.find((x) => !x.cond || truthy(x.cond(scope)));
      if (b) out += render(b.body, scope);
    }
  }
  return out;
}

export interface Template {
  source: string;
  /** Renders with `value` (the raw payload) and `value_json` (parsed, when it is JSON). Throws TemplateError. */
  render(vars: Scope): string;
}

/** Compiles once; throws TemplateError for unsupported syntax. */
export function compile(source: string): Template {
  const nodes = parseNodes(source);
  return { source, render: (vars) => render(nodes, vars) };
}

/** Variables for an MQTT payload: `value` is the text, `value_json` the parsed JSON (undefined when it isn't valid JSON). */
export function payloadVars(payload: string): Scope {
  let json: V = UNDEFINED;
  try {
    json = JSON.parse(payload);
  } catch {}
  return { value: payload, value_json: json };
}
