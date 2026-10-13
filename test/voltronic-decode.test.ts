import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeCurrentList, decodeFlags, decodeMode, decodeReply, decodeStatus, decodeWarnings,
} from '../src/devices/inverters/voltronic/decode.ts';
import { VoltronicDriver } from '../src/devices/inverters/voltronic/driver.ts';
import { voltronic } from '../src/devices/inverters/voltronic/index.ts';
import { voltronicCrc, type Transport } from '../src/devices/inverters/voltronic/protocol.ts';
import { decodeSettings, encodeSetting, settingDefs, volts, type SettingContext } from '../src/devices/inverters/voltronic/settings.ts';

// Axpert MKS 5K on battery, PV charging.
const QPIGS_BATT = '000.0 00.0 230.0 49.9 0161 0119 003 460 52.10 012 080 0045 0011 245.3 52.08 00000 00010110 00 00 00283 010';
// Line mode, AC + PV charging the battery.
const QPIGS_LINE = '231.4 50.0 231.4 50.0 0520 0480 010 410 53.20 030 070 0040 0005 220.1 53.10 00000 00010111 00 00 00270 010';
// Discharging, early firmware without field 19.
const QPIGS_OLD = '000.0 00.0 229.8 50.0 0800 0750 016 380 49.20 000 045 0038 0000 000.0 00.00 00016 00010000 00 00';
const QPIRI = '230.0 21.7 230.0 50.0 21.7 5000 5000 48.0 46.0 42.0 56.4 54.0 2 30 060 0 2 3 9 01 0 0 54.0 0 1';
const QFLAG = 'EakxyzDbjuv';

test('QPIGS on battery', () => {
  const m = decodeStatus(QPIGS_BATT, 'Solar/Battery');
  assert.equal(m['Grid voltage'], 0);
  assert.equal(m['AC output voltage'], 230);
  assert.equal(m['AC output frequency'], 49.9);
  assert.equal(m['Load apparent power'], 161);
  assert.equal(m['Load power'], 119);
  assert.equal(m['Load percentage'], 3);
  assert.equal(m['Bus voltage'], 460);
  assert.equal(m['Battery voltage'], 52.1);
  assert.equal(m['Battery current'], 12);
  assert.equal(m['Battery power'], 625);
  assert.equal(m['Battery state of charge'], 80);
  assert.equal(m.Temperature, 45);
  assert.equal(m['PV voltage 1'], 245.3);
  assert.equal(m['PV current 1'], 11);
  assert.equal(m['PV power 1'], 283);
  assert.equal(m['PV power'], 283);
  assert.equal(m['Grid power'], 0);
  assert.equal(m['Device mode'], 'Solar/Battery');
});

test('QPIGS in Line mode: grid power = load + AC share of charging', () => {
  const m = decodeStatus(QPIGS_LINE, 'Grid');
  // battery 53.2 V × 30 A = 1596 W, PV 270 W → AC charge 1326 W; load 480 W
  assert.equal(m['Battery power'], 1596);
  assert.equal(m['Grid power'], 480 + 1326);
});

test('QPIGS on early firmware: discharge current, PV power from V × I', () => {
  const m = decodeStatus(QPIGS_OLD, 'Solar/Battery');
  assert.equal(m['Battery current'], -16);
  assert.equal(m['Battery power'], Math.round(49.2 * -16));
  assert.equal(m['PV power'], 0);
});

test('QPIGS2 adds the second MPPT', () => {
  const m = decodeStatus(QPIGS_BATT, 'Solar/Battery', '05.2 310.4 01614');
  assert.equal(m['PV current 2'], 5.2);
  assert.equal(m['PV voltage 2'], 310.4);
  assert.equal(m['PV power 2'], 1614);
  assert.equal(m['PV power'], 283 + 1614);
});

test('QMOD, QPIWS, QFLAG, QMCHGCR', () => {
  assert.equal(decodeMode('B'), 'Solar/Battery');
  assert.equal(decodeMode('L'), 'Grid');
  assert.equal(decodeMode('S'), 'Standby');
  assert.equal(decodeMode('F'), 'Fault');
  assert.equal(decodeMode('H'), 'Power saving');
  assert.equal(decodeMode('Q'), 'Unknown (Q)');
  assert.equal(decodeWarnings('00000000000000000000000000000000'), '');
  assert.equal(decodeWarnings('00000100000010000000000000000000'), 'Line fail, Battery low alarm');
  assert.deepEqual(decodeFlags(QFLAG), { a: true, k: true, x: true, y: true, z: true, b: false, j: false, u: false, v: false });
  assert.deepEqual(decodeCurrentList('002 010 020 030'), ['2', '10', '20', '30']);
});

const ctx: SettingContext = { model: 'axpert', nominalVoltage: 48, chargeCurrents: [], gridChargeCurrents: [] };

test('QPIRI + QFLAG → settings', () => {
  const s = decodeSettings('axpert', QPIRI, QFLAG);
  assert.equal(s.battery_type, 'User-defined');
  assert.equal(s.to_grid_battery_voltage, 46);
  assert.equal(s.shutdown_battery_voltage, 42);
  assert.equal(s.back_to_battery_voltage, 54);
  assert.equal(s.battery_absorption_charge_voltage, 56.4);
  assert.equal(s.battery_float_charge_voltage, 54);
  assert.equal(s.max_grid_charge_current, '30');
  assert.equal(s.max_charge_current, '60');
  assert.equal(s.ac_input_voltage_range, 'Appliance');
  assert.equal(s.output_source_priority, 'Solar/Battery/Utility');
  assert.equal(s.charger_source_priority, 'Solar only');
  assert.equal(s.output_mode, 'Single');
  assert.equal(s.ac_output_frequency, '50');
  assert.equal(s.buzzer, true);
  assert.equal(s.overload_restart, false);
  assert.equal(s.power_saving, false);
  assert.equal(s.lcd_backlight, true);
});

test('setting command encoding', () => {
  assert.equal(encodeSetting('axpert', 'to_grid_battery_voltage', 46, ctx), 'PBCV46.0');
  assert.equal(encodeSetting('axpert', 'back_to_battery_voltage', 0, ctx), 'PBDV00.0');
  assert.equal(encodeSetting('axpert', 'shutdown_battery_voltage', 42.5, ctx), 'PSDV42.5');
  assert.equal(encodeSetting('axpert', 'battery_float_charge_voltage', 54, ctx), 'PBFT54.0');
  assert.equal(encodeSetting('axpert', 'battery_absorption_charge_voltage', 56.4, ctx), 'PCVV56.4');
  assert.equal(encodeSetting('axpert', 'output_source_priority', 'Utility first', ctx), 'POP00');
  assert.equal(encodeSetting('axpert', 'output_source_priority', 'Solar/Battery/Utility', ctx), 'POP02');
  assert.equal(encodeSetting('axpert', 'charger_source_priority', 'Solar and utility simultaneously', ctx), 'PCP02');
  assert.equal(encodeSetting('axpert', 'max_charge_current', '60', ctx), 'MCHGC060');
  assert.equal(encodeSetting('axpert', 'max_charge_current', '120', ctx), 'MNCHGC0120');
  assert.equal(encodeSetting('axpert_king', 'max_charge_current', '60', { ...ctx, model: 'axpert_king' }), 'MNCHGC0060');
  assert.equal(encodeSetting('axpert', 'max_grid_charge_current', '30', ctx), 'MUCHGC030');
  assert.equal(encodeSetting('axpert', 'battery_type', 'Flooded', ctx), 'PBT01');
  assert.throws(() => encodeSetting('axpert', 'battery_type', 'Pylontech', ctx), /not supported/);
  assert.equal(encodeSetting('axpert', 'ac_input_voltage_range', 'UPS', ctx), 'PGR01');
  assert.equal(encodeSetting('axpert', 'buzzer', true, ctx), 'PEa');
  assert.equal(encodeSetting('axpert', 'lcd_backlight', false, ctx), 'PDx');
  assert.equal(encodeSetting('axpert', 'over_temperature_restart', true, ctx), 'PEv');
  assert.throws(() => encodeSetting('axpert', 'output_mode', 'Single', ctx), /read-only/);
  assert.throws(() => encodeSetting('infinisolar', 'output_source_priority', 'Utility first', { ...ctx, model: 'infinisolar' }), /read-only/);
  assert.equal(volts(5), '05.0');
});

test('setting defs: keys, ranges scale with nominal voltage, read-only flags', () => {
  const defs = settingDefs(ctx);
  const byKey = Object.fromEntries(defs.map((d) => [d.key, d]));
  assert.deepEqual(byKey.output_source_priority.options, ['Utility first', 'Solar first', 'Solar/Battery/Utility']);
  assert.equal(byKey.output_source_priority.section, 'Input/output');
  assert.equal(byKey.shutdown_battery_voltage.min, 40);
  assert.equal(byKey.output_mode.readOnly, true);
  assert.equal(byKey.buzzer.section, 'Miscellaneous');
  assert.equal(byKey.operation_logic, undefined);
  const defs24 = Object.fromEntries(settingDefs({ ...ctx, nominalVoltage: 24 }).map((d) => [d.key, d]));
  assert.equal(defs24.shutdown_battery_voltage.min, 20);
  const king = Object.fromEntries(settingDefs({ ...ctx, model: 'axpert_king' }).map((d) => [d.key, d]));
  assert.deepEqual(king.charger_source_priority.options, ['Solar first', 'Solar and utility simultaneously', 'Solar only']);
  assert.ok(king.operation_logic.readOnly);
  assert.ok(settingDefs({ ...ctx, model: 'infinisolar' }).every((d) => d.readOnly));
});

test('descriptor', () => {
  assert.equal(voltronic.id, 'voltronic');
  assert.equal(voltronic.defaultBaudRate, 2400);
  assert.deepEqual(voltronic.models?.map((m) => m.id), ['axpert', 'axpert_king', 'axpert_max', 'infinisolar']);
  assert.deepEqual(voltronic.socControl?.('axpert'), {
    setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility',
  });
  assert.equal(voltronic.protectionSetting?.('axpert'), null);
});

test('console decoder', () => {
  const r = decodeReply('QPIGS', QPIGS_BATT)!;
  assert.equal(r['Battery voltage'], 52.1);
  assert.equal(r['Device status'], '00010110');
  assert.equal(r['SCC charging'], true);
  assert.equal(decodeReply('QPIRI', QPIRI)!['Output source priority'], '2');
  assert.equal(decodeReply('QFLAG', QFLAG)!.Buzzer, true);
  assert.equal(decodeReply('PBCV46.0', 'ACK'), undefined);
});

/** A fake inverter answering from a table, with correct CRCs. */
function fakeInverter(answers: Record<string, string>, log: string[] = []): Transport {
  return {
    open: async () => {},
    close: async () => {},
    exchange: async (req) => {
      const cmd = req.subarray(0, req.length - 3).toString('latin1');
      log.push(cmd);
      const body = Buffer.from('(' + (answers[cmd] ?? (/^(P|M)/.test(cmd) ? 'ACK' : 'NAK')), 'latin1');
      const crc = voltronicCrc(body);
      return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
    },
  };
}

test('driver end to end with a fake inverter', async () => {
  const log: string[] = [];
  const d = new VoltronicDriver({
    modelId: 'axpert_max', connection: '/dev/ttyUSB0', baudRate: 2400, address: 0, index: 0,
    transport: fakeInverter({
      QPIGS: QPIGS_BATT, QPIGS2: '05.2 310.4 01614', QMOD: 'B', QPIWS: '00000100000000000000000000000000',
      QPI: 'PI30', QID: '92932004102443', QVFW: 'VERFW:00072.70', QPIRI: QPIRI, QFLAG: QFLAG,
      QMCHGCR: '010 020 030 040 050 060 070 080 090 100 110 120', QMUCHGCR: '002 010 020 030 040 050 060',
    }, log),
  });
  await d.connect();
  const info = d.info();
  assert.equal(info['Serial number'], '92932004102443');
  assert.equal(info['Firmware version'], '00072.70');
  assert.equal(info['Protocol version'], 'PI30');
  assert.equal(info['Max AC output power'], 5000);
  const m = await d.read();
  assert.equal(m['Device mode'], 'Solar/Battery');
  assert.equal(m['PV power'], 283 + 1614);
  assert.equal(m['Fault code'], 'Line fail');
  const defs = d.settingDefs();
  assert.equal(defs.find((x) => x.key === 'max_charge_current')!.options!.at(-1), '120');
  const s = await d.readSettings();
  assert.equal(s.output_source_priority, 'Solar/Battery/Utility');
  await d.writeSetting('output_source_priority', 'Utility first');
  assert.equal(log.at(-1), 'POP00');
  assert.equal(await d.rawCommand('QMOD'), 'B');
  assert.equal(await d.rawCommand('QXYZ'), 'NAK');
});

test('driver: QPIGS2 NAK stops asking', async () => {
  const log: string[] = [];
  const d = new VoltronicDriver({
    modelId: 'axpert_king', connection: '/dev/hidraw0', baudRate: 2400, address: 0, index: 0,
    transport: fakeInverter({ QPIGS: QPIGS_BATT, QMOD: 'L' }, log),
  });
  await d.read();
  await d.read();
  assert.equal(log.filter((c) => c === 'QPIGS2').length, 1);
});
