# gladys-modern-forms

[Gladys Assistant](https://gladysassistant.com) integration for **Modern Forms
and WAC smart ceiling fans** (generations 1 to 3), through their local HTTP API,
without account nor cloud: fan on / off and speed, direction, breeze mode,
light and brightness.

- Offs (fan speed 0, light off) go first, without any option, are kept in
  `/data` and sent again until a read shows them.
- A device drives only its own fan (known by its `clientId`, the MAC address
  the fan gives in every answer).
- The e-mail of the app account, which the fan also gives, is never used nor
  kept.
- Generation 4 fans (another API) are not handled yet.

Never tested with a real device. Not affiliated with WAC Lighting nor Modern
Forms.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
node scripts/cover.mjs cover.png   # the store cover
```

See `CLAUDE.md` (architecture, rules) and `TODO.md` (status, decisions).
Licensed under the Apache License 2.0; ported logic credited in
`THIRD_PARTY_NOTICES.md`.
