/**
 * Supported boards and what each can run. Pure, so it can be unit tested on any OS.
 *
 * The smart-device feature has two engines: "full" runs every Home Assistant integration (Home Assistant
 * Core in a container, which needs a 64-bit OS and about 2 GB of RAM); "lite" uses Sunroost's own drivers and
 * runs on every supported board.
 */

export type BoardFamily = 'pi1' | 'pi-zero' | 'pi-zero-2w' | 'pi2' | 'pi3' | 'pi4' | 'pi5' | 'orangepi-3-lts' | 'other';
export type DeviceEngine = 'full' | 'lite';

export interface BoardProfile {
  family: BoardFamily;
  /** Short display name, e.g. "Raspberry Pi Zero 2 W". */
  name: string;
  /** One of the boards Sunroost is built and tested for. */
  supported: boolean;
  /** Node's process.arch: arm (32-bit), arm64, x64. */
  arch: string;
  ramMb: number;
  engine: {
    recommended: DeviceEngine;
    /** yes = runs well; limited = fits, but tight on memory; no = can't run here. */
    full: 'yes' | 'limited' | 'no';
    /** Why "full" isn't "yes", for the UI. */
    reason: string | null;
  };
}

/** 2 GB boards report about 1.8 GiB after the GPU and kernel take their share. */
const FULL_MIN_MB = 1500;
/** 1 GB boards report about 900 MiB. */
const FULL_LIMITED_MIN_MB = 700;

const BOARDS: { family: BoardFamily; name: string; match: RegExp; can64: boolean }[] = [
  // Order matters: "Zero 2" before "Zero", "500" before "5", and "Pi 1" (no number) last.
  { family: 'pi-zero-2w', name: 'Raspberry Pi Zero 2 W', match: /raspberry pi zero 2/i, can64: true },
  { family: 'pi-zero', name: 'Raspberry Pi Zero', match: /raspberry pi zero/i, can64: false },
  { family: 'pi5', name: 'Raspberry Pi 5', match: /raspberry pi (?:compute module )?(?:5|500)\b/i, can64: true },
  { family: 'pi4', name: 'Raspberry Pi 4', match: /raspberry pi (?:compute module )?(?:4|400)\b/i, can64: true },
  { family: 'pi3', name: 'Raspberry Pi 3', match: /raspberry pi (?:compute module )?3\b/i, can64: true },
  { family: 'pi2', name: 'Raspberry Pi 2', match: /raspberry pi 2\b/i, can64: false },
  { family: 'pi1', name: 'Raspberry Pi 1', match: /raspberry pi (?:model|compute module rev)/i, can64: false },
  { family: 'orangepi-3-lts', name: 'Orange Pi 3 LTS', match: /orange\s*pi\s*3\s*lts/i, can64: true },
];

/**
 * @param model /proc/device-tree/model (already trimmed), or any display string on other machines
 * @param arch process.arch: the OS userland, so a 32-bit OS on a 64-bit Pi reports "arm"
 * @param totalMemBytes os.totalmem()
 */
export function boardProfile(model: string, arch: string, totalMemBytes: number): BoardProfile {
  const board = BOARDS.find((b) => b.match.test(model));
  const ramMb = Math.round(totalMemBytes / 1048576);
  const is64 = arch === 'arm64' || arch === 'x64';

  let full: BoardProfile['engine']['full'];
  let reason: string | null = null;
  if (!is64) {
    full = 'no';
    reason = board?.can64
      ? 'All Home Assistant integrations need the 64-bit OS. Reinstall with the 64-bit image to enable them.'
      : 'All Home Assistant integrations need a 64-bit board. This board uses Sunroost\'s built-in device drivers.';
  } else if (ramMb >= FULL_MIN_MB) {
    full = 'yes';
  } else if (ramMb >= FULL_LIMITED_MIN_MB) {
    full = 'limited';
    reason = `All Home Assistant integrations fit in ${ramMb} MB of RAM but leave little headroom; 2 GB or more is recommended.`;
  } else {
    full = 'no';
    reason = `All Home Assistant integrations need about 2 GB of RAM (this board has ${ramMb} MB).`;
  }

  return {
    family: board?.family ?? 'other',
    name: board?.name ?? (model || 'Unknown'),
    supported: !!board,
    arch,
    ramMb,
    engine: { recommended: full === 'yes' ? 'full' : 'lite', full, reason },
  };
}
