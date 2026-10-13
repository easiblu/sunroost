/**
 * Diagnostic tools: serial test, serial inspect / trace replay, protocol broker, serial BMS
 * console and the standalone Modbus console. `stopAll()` stops every engine and closes every
 * port they hold; call it on app shutdown (and it is safe to call any time).
 */
import { bmsConsole } from './bms-console.ts';
import { broker } from './broker.ts';
import { inspector } from './inspect.ts';
import { modbusConsole } from './modbus-console.ts';
import { closeAllPorts } from './port.ts';
import { serialTest } from './serial-test.ts';

export { bmsConsole, broker, inspector, modbusConsole, serialTest };

export async function stopAll() {
  await Promise.allSettled([serialTest.stop(), inspector.stop(), broker.stop(), bmsConsole.disconnect(), modbusConsole.disconnect()]);
  await closeAllPorts();
}
