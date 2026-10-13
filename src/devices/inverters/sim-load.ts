/**
 * Extra household load for the inverter simulator: what the simulated smart devices draw (demo
 * plug, AC, EV charger), so switching them changes the simulated house like real appliances would.
 */
let extraW = 0;

export const simulatedDeviceLoadW = () => extraW;

export function setSimulatedDeviceLoad(w: number) {
  extraW = Math.max(0, w);
}
