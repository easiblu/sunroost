/**
 * Turns Home Assistant config-flow steps into plain, translated forms for Sunroost's UI. Home Assistant
 * describes fields in two styles (voluptuous types and selectors) and keeps labels in its
 * translation strings; the UI gets one simple shape either way. Pure functions.
 */

export type Translations = Record<string, string>;

export interface UiOption {
  value: string;
  label: string;
}

export interface UiField {
  name: string;
  label: string;
  help: string | null;
  kind: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'multiselect' | 'section' | 'unsupported';
  required: boolean;
  default?: unknown;
  options?: UiOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  multiline?: boolean;
  /** Fields of a section (kind "section"); submitted as a nested object under `name`. */
  fields?: UiField[];
  collapsed?: boolean;
}

export type FlowView =
  | { type: 'form'; flowId: string; handler: string; stepId: string; title: string; description: string | null; fields: UiField[]; errors: Record<string, string>; lastStep: boolean | null }
  | { type: 'menu'; flowId: string; handler: string; stepId: string; title: string; description: string | null; options: UiOption[] }
  | { type: 'external'; flowId: string; handler: string; stepId: string; title: string; description: string | null; url: string }
  | { type: 'progress'; flowId: string; handler: string; stepId: string; title: string; description: string | null }
  | { type: 'create_entry'; handler: string; title: string; description: string | null }
  | { type: 'abort'; handler: string; title: string; reason: string };

const humanize = (s: string) => {
  const t = s.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Replaces {placeholders} with values; leaves unknown ones as they are. */
export function fillPlaceholders(text: string, placeholders: Record<string, unknown> | null | undefined): string {
  if (!placeholders) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in placeholders && placeholders[k] !== null ? String(placeholders[k]) : m));
}

function optionList(raw: unknown, tr: Translations, handler: string, translationKey?: string): UiOption[] {
  const label = (value: string, fallback: string) =>
    (translationKey && tr[`component.${handler}.selector.${translationKey}.options.${value}`]) || fallback;
  if (Array.isArray(raw)) {
    return raw.map((o) => {
      if (Array.isArray(o)) return { value: String(o[0]), label: label(String(o[0]), String(o[1] ?? o[0])) };
      if (o && typeof o === 'object') {
        const v = String((o as Record<string, unknown>).value);
        return { value: v, label: label(v, String((o as Record<string, unknown>).label ?? v)) };
      }
      return { value: String(o), label: label(String(o), String(o)) };
    });
  }
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([v, l]) => ({ value: v, label: label(v, String(l)) }));
  return [];
}

/**
 * A field's starting value, as Home Assistant's own form fills it: its default, else for a required
 * field false (yes/no) or the first option (dropdown). Undefined when the user must enter it.
 */
export function initialValue(raw: Record<string, any>): unknown {
  if (raw.default !== undefined) return raw.default;
  if (raw.required !== true) return undefined;
  const sel = raw.selector as Record<string, any> | undefined;
  if (sel?.boolean || raw.type === 'boolean') return false;
  const opts = sel?.select ? (sel.select.multiple ? null : sel.select.options) : raw.type === 'select' ? raw.options : null;
  if (Array.isArray(opts) && opts.length) {
    const first = opts[0];
    return Array.isArray(first) ? first[0] : first && typeof first === 'object' ? first.value : first;
  }
  if (sel?.select?.multiple) return [];
  return undefined;
}

/**
 * One field. `prefix` is the translation path of the step, e.g. "component.mqtt.config.step.broker";
 * fields in a section use "<prefix>.sections.<section>".
 */
export function field(raw: Record<string, any>, tr: Translations, handler: string, prefix: string): UiField {
  const name = String(raw.name);
  const base: UiField = {
    name,
    label: tr[`${prefix}.data.${name}`] || humanize(name),
    help: tr[`${prefix}.data_description.${name}`] || null,
    kind: 'text',
    required: raw.required === true,
    ...(initialValue(raw) !== undefined ? { default: initialValue(raw) } : {}),
  };
  if (raw.type === 'expandable') {
    const secPrefix = `${prefix}.sections.${name}`;
    return {
      ...base,
      label: tr[`${secPrefix}.name`] || humanize(name),
      help: tr[`${secPrefix}.description`] || null,
      kind: 'section',
      required: false,
      collapsed: raw.expanded !== true,
      fields: (raw.schema ?? []).map((f: Record<string, any>) => field(f, tr, handler, secPrefix)),
    };
  }
  const sel = raw.selector as Record<string, any> | undefined;
  if (sel) {
    const [kind, cfg = {}] = Object.entries(sel)[0] ?? [];
    switch (kind) {
      case 'text':
        return { ...base, kind: cfg.type === 'password' ? 'password' : 'text', multiline: cfg.multiline === true };
      case 'number':
        return { ...base, kind: 'number', min: cfg.min, max: cfg.max, step: cfg.step, unit: cfg.unit_of_measurement };
      case 'boolean':
        return { ...base, kind: 'boolean' };
      case 'select':
        return { ...base, kind: cfg.multiple ? 'multiselect' : 'select', options: optionList(cfg.options, tr, handler, cfg.translation_key) };
      default:
        return { ...base, kind: 'unsupported', help: `${base.help ? base.help + ' ' : ''}(This kind of field can't be shown in Sunroost yet.)` };
    }
  }
  switch (raw.type) {
    case 'string':
      return { ...base, kind: /password|token|secret|api_key/i.test(name) ? 'password' : 'text' };
    case 'integer':
    case 'float':
      return { ...base, kind: 'number', min: raw.valueMin, max: raw.valueMax, step: raw.type === 'integer' ? 1 : undefined };
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'select':
      return { ...base, kind: 'select', options: optionList(raw.options, tr, handler) };
    case 'multi_select':
      return { ...base, kind: 'multiselect', options: optionList(raw.options, tr, handler) };
    case 'constant_value':
      return { ...base, kind: 'unsupported', default: raw.value };
    default:
      return { ...base, kind: 'unsupported' };
  }
}

/** Converts a flow step (from POST/GET …/config_entries/flow) to a FlowView. `name` is the integration's display name. */
export function flowView(step: Record<string, any>, tr: Translations, name: string): FlowView {
  const handler = String(step.handler);
  const stepId = String(step.step_id ?? '');
  const prefix = `component.${handler}.config.step.${stepId}`;
  const ph = step.description_placeholders as Record<string, unknown> | null;
  const title = fillPlaceholders(tr[`${prefix}.title`] || name, ph);
  const descRaw = tr[`${prefix}.description`] ?? step.description ?? null;
  const description = descRaw ? fillPlaceholders(String(descRaw), ph) : null;
  switch (step.type) {
    case 'form': {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries((step.errors ?? {}) as Record<string, string>)) {
        errors[k] = fillPlaceholders(tr[`component.${handler}.config.error.${v}`] || humanize(v), ph);
      }
      return {
        type: 'form', flowId: step.flow_id, handler, stepId, title, description, errors, lastStep: step.last_step ?? null,
        fields: (step.data_schema ?? []).map((f: Record<string, any>) => field(f, tr, handler, prefix)),
      };
    }
    case 'menu': {
      const opts: [string, unknown][] = Array.isArray(step.menu_options)
        ? step.menu_options.map((o: string) => [o, o])
        : Object.entries(step.menu_options ?? {});
      return {
        type: 'menu', flowId: step.flow_id, handler, stepId, title, description,
        options: opts.map(([v, l]) => ({ value: v, label: tr[`${prefix}.menu_options.${v}`] || humanize(String(l)) })),
      };
    }
    case 'external':
      return { type: 'external', flowId: step.flow_id, handler, stepId, title, description, url: String(step.url) };
    case 'progress':
      return { type: 'progress', flowId: step.flow_id, handler, stepId, title, description };
    case 'create_entry':
      return { type: 'create_entry', handler, title: String(step.title ?? name), description };
    case 'abort': {
      const reason = String(step.reason ?? 'aborted');
      return { type: 'abort', handler, title: name, reason: fillPlaceholders(tr[`component.${handler}.config.abort.${reason}`] || humanize(reason), ph) };
    }
    default:
      return { type: 'abort', handler, title: name, reason: `Unsupported step type "${step.type}"` };
  }
}

export interface Integration {
  domain: string;
  name: string;
  iotClass: string | null;
  /** Brand it belongs to, e.g. Philips for "hue". */
  brand: string | null;
}

/**
 * Flattens `integration/descriptions` into the integrations that can be added with a config flow.
 * Brands (Shelly, Philips …) contain several integrations; virtual integrations point at another.
 */
export function catalogue(desc: { core?: { integration?: Record<string, any> }; custom?: { integration?: Record<string, any> } }): Integration[] {
  const out = new Map<string, Integration>();
  const add = (domain: string, d: Record<string, any>, brand: string | null) => {
    if (d.config_flow !== true || d.integration_type === 'virtual' || out.has(domain)) return;
    out.set(domain, { domain, name: String(d.name ?? humanize(domain)), iotClass: d.iot_class ?? null, brand });
  };
  for (const source of [desc.core?.integration ?? {}, desc.custom?.integration ?? {}]) {
    for (const [domain, d] of Object.entries(source)) {
      if (d.integrations && typeof d.integrations === 'object') {
        for (const [sub, sd] of Object.entries(d.integrations as Record<string, any>)) add(sub, sd, d.name ?? null);
      } else add(domain, d, null);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
