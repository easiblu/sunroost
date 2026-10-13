/** Helpers for identifying devices from register contents. */

/** Registers (2 ASCII chars each, high byte first) → trimmed text. */
export function regsToAscii(regs: number[]): string {
  return regs
    .flatMap((r) => [r >> 8, r & 0xff])
    .map((c) => String.fromCharCode(c))
    .join('')
    .replace(/\0/g, '')
    .trim();
}

/**
 * A plausible serial number / version string: printable ASCII at least `min` long, with a run of
 * letters/digits (4, or `min` if shorter) so blank or 0xFFFF-filled registers don't pass.
 */
export function plausibleId(text: string, min = 6): boolean {
  const run = new RegExp(`[A-Za-z0-9]{${Math.min(4, min)}}`);
  return text.length >= min && /^[\x20-\x7e]+$/.test(text) && run.test(text);
}
