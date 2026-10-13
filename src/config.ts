/** Boot configuration: only what's needed before the settings database opens. */
import { existsSync, readFileSync } from 'node:fs';

export interface BootConfig {
  http: { host: string; port: number };
  dataDir: string;
  /** Settings applied on the first run only (keys not stored yet), e.g. installs start with no inverter. */
  initialSettings: Record<string, unknown>;
}

export function loadBootConfig(path = process.env.SOLAR_CONFIG ?? 'config.json'): BootConfig {
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return {
    http: {
      host: process.env.SOLAR_HOST ?? file.http?.host ?? '0.0.0.0',
      port: Number(process.env.SOLAR_PORT ?? file.http?.port ?? 8080),
    },
    dataDir: process.env.SOLAR_DATA ?? file.dataDir ?? 'data',
    initialSettings: file.initialSettings && typeof file.initialSettings === 'object' ? file.initialSettings : {},
  };
}
