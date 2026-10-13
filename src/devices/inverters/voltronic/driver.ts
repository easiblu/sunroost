/**
 * The Voltronic driver: polls QPIGS + QMOD (+ QPIGS2 on dual-MPPT models, QPIWS every few polls),
 * reads settings from QPIRI + QFLAG, and reads identity (QPI/QID/QVFW/QMN) once on connect.
 */
import type { Metrics, Value } from '../../../core/metrics.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeCurrentList, decodeMode, decodeRatingInfo, decodeStatus, decodeWarnings } from './decode.ts';
import { transportFor, VoltronicLink, type Transport } from './protocol.ts';
import { decodeSettings, encodeSetting, settingDefs, type SettingContext, type VoltronicModel } from './settings.ts';

export const MODEL_NAMES: Record<VoltronicModel, string> = {
  axpert: 'Axpert / VM / MKS',
  axpert_king: 'Axpert King / MKS II',
  axpert_max: 'Axpert MAX (dual MPPT)',
  infinisolar: 'InfiniSolar V (UNVERIFIED, read-only)',
};

export function voltronicModel(id: string): VoltronicModel {
  return id in MODEL_NAMES ? (id as VoltronicModel) : 'axpert';
}

/**
 * Process-wide default for CRC verification (the "CRC verification" advanced option). A driver
 * created without an explicit `verifyCrc` uses this.
 */
export const voltronicDefaults = { verifyCrc: true };

/** QPIWS is polled once every this many status polls. */
const WARNINGS_EVERY = 10;

export interface VoltronicOptions extends DriverOptions {
  verifyCrc?: boolean;
  /** Injected transport (tests); otherwise chosen from the connection path. */
  transport?: Transport;
}

export class VoltronicDriver implements InverterDriver {
  readonly model: VoltronicModel;
  readonly link: VoltronicLink;
  private infoMetrics: Metrics;
  private ctx: SettingContext;
  /** null = unknown yet, false = inverter NAKs it. */
  private hasPigs2: boolean | null;
  private polls = 0;
  private warnings = '';

  constructor(opts: VoltronicOptions) {
    this.model = voltronicModel(opts.modelId);
    this.link = new VoltronicLink(opts.transport ?? transportFor(opts.connection, opts.baudRate), {
      verifyCrc: opts.verifyCrc ?? voltronicDefaults.verifyCrc,
    });
    this.infoMetrics = { 'Model name': `Voltronic ${MODEL_NAMES[this.model]}` };
    this.ctx = { model: this.model, nominalVoltage: 48, chargeCurrents: [], gridChargeCurrents: [] };
    this.hasPigs2 = this.model === 'axpert_king' || this.model === 'axpert_max' ? null : false;
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.link.open();
    // Fail fast when nothing answers: QPIGS is the one query every unit supports.
    await this.link.ask('QPIGS');
    const info: Metrics = {};
    const opt = async (cmd: string, fn: (reply: string) => void) => {
      try {
        fn(await this.link.ask(cmd));
      } catch {
        // Not every model knows every query; identity is best effort.
      }
    };
    await opt('QPI', (r) => (info['Protocol version'] = r.trim()));
    await opt('QID', (r) => (info['Serial number'] = r.trim()));
    await opt('QVFW', (r) => (info['Firmware version'] = r.replace(/^VERFW:?/, '').trim()));
    await opt('QVFW2', (r) => (info['Secondary firmware version'] = r.replace(/^VERFW2:?/, '').trim()));
    await opt('QMN', (r) => (info['Model name'] = r.trim()));
    await opt('QPIRI', (r) => {
      Object.assign(info, decodeRatingInfo(r));
      const nominal = Number(info['Nominal battery voltage']);
      if (nominal > 0) this.ctx.nominalVoltage = nominal;
    });
    await opt('QMCHGCR', (r) => (this.ctx.chargeCurrents = decodeCurrentList(r)));
    await opt('QMUCHGCR', (r) => (this.ctx.gridChargeCurrents = decodeCurrentList(r)));
    this.infoMetrics = { ...this.infoMetrics, ...info };
  }

  async close() {
    await this.link.close();
  }

  async read(): Promise<Metrics> {
    const qpigs = await this.link.ask('QPIGS');
    let mode: string | null = null;
    try {
      mode = decodeMode(await this.link.ask('QMOD'));
    } catch {}
    let qpigs2: string | null = null;
    if (this.hasPigs2 !== false) {
      try {
        qpigs2 = await this.link.ask('QPIGS2');
        this.hasPigs2 = true;
      } catch (err) {
        // A NAK means the firmware has no second MPPT query; stop asking. Timeouts are retried later.
        if (this.hasPigs2 === null && /NAK/.test((err as Error).message)) this.hasPigs2 = false;
      }
    }
    if (this.polls++ % WARNINGS_EVERY === 0) {
      try {
        this.warnings = decodeWarnings(await this.link.ask('QPIWS'));
      } catch {}
    }
    const m = decodeStatus(qpigs, mode, qpigs2);
    m['Fault code'] = this.warnings || 'None';
    return m;
  }

  settingDefs(): SettingDef[] {
    return settingDefs(this.ctx);
  }

  async readSettings(): Promise<SettingValues> {
    const qpiri = await this.link.ask('QPIRI');
    let qflag: string | null = null;
    try {
      qflag = await this.link.ask('QFLAG');
    } catch {}
    const nominal = Number(qpiri.trim().split(/\s+/)[7]);
    if (nominal > 0) this.ctx.nominalVoltage = nominal;
    return decodeSettings(this.model, qpiri, qflag);
  }

  async writeSetting(key: string, value: Value) {
    await this.link.set(encodeSetting(this.model, key, value, this.ctx));
  }

  /** Console access: any command, reply payload as text ("NAK" included). */
  rawCommand(command: string): Promise<string> {
    return this.link.query(command);
  }
}
