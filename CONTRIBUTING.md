# Contributing to Sunroost

Thanks for helping. The most valuable contributions right now are **reports from real hardware**: most inverter drivers
were written from documents and have never talked to a real unit.

## Reporting a bug
Open a *Bug report* issue with what you did, what happened, what you expected, your board and image/version, and the
log (`journalctl -u sunroost -n 200`, or **Configuration → Tools → Logs**). Remove passwords and IP addresses you don't
want public.

## Hardware reports (inverters and batteries)
Open a *Hardware report* issue. Include the brand, exact model, connection (USB / RS485 / WiFi stick …), and for a few
readings both what Sunroost shows and what the inverter's own display shows. `docs/HARDWARE_TEST.md` lists what to check
per brand. Register dumps from **Configuration → Tools → Modbus console** help a lot.

A driver (or one setting) becomes writable only after a report confirms it on hardware. Never test writes on a system
you can't afford to have misbehave.

## Code
- Node 22.18+ runs the TypeScript directly; there is no build step. `npm install`, then `npm start` (simulator) or
  `npm run dev`.
- Before a pull request: `npm run typecheck` and `npm test` must pass. Add tests for new behaviour; drivers need a fake
  device test and an identity image in `test/inverter-detect-cross.test.ts`.
- Match the style of the code around you. TypeScript must be *erasable* (no enums, no parameter properties, no
  namespaces) because Node strips types at runtime.
- New inverter drivers start with `readOnly: true`. Note your source and confidence for every register.
- **Clean-room rule:** only use vendor documents, public specifications and your own measurements. Do not copy code,
  text or assets from other projects unless their licence allows it and you keep their notice; never from proprietary
  products.
- Keep MQTT topic names stable: other people's automations depend on them.

## Pull requests
Keep them focused, describe what changed and how you tested it, and link the issue. By submitting a contribution you
agree that it is licensed under the project's MIT licence.
