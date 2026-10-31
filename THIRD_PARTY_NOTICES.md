# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below. The ported parts were rewritten
in JavaScript; they are changed from the original (another language, another
structure, only what this integration needs). None of the original code is
copied as is.

## aiomodernforms

- Project: [wonderslug/aiomodernforms](https://github.com/wonderslug/aiomodernforms)
  version 0.3.1 (commit e572e78), "Asynchronous Python client for Modern
  Forms Fans", by Brian Towles, MIT licence; the library of the Home Assistant
  Modern Forms integration.
- What is ported (in `src/constants.js` and `src/fan/model.js`): the
  `POST /mf` requests (`queryDynamicShadowData`, `queryStaticShadowData`, the
  command fields `fanOn`, `fanSpeed`, `fanDirection`, `wind`, `lightOn`,
  `lightBrightness`), their ranges (speed 1-6, brightness 1-100), the
  `clientId` / `mac` / `deviceName` / `fanType` fields; the test fake of
  `test/helpers/fakeFans.js` follows the state of its mock fan (`mock_fan/`).
  The WAC reference shipped in its repository ("WAC and Modern Forms Smart
  Fans IP API, Definition for 3rd Party Integrations", 2021) was read for the
  same facts; nothing of it is copied.
- Changes: rewritten in JavaScript for a Gladys external integration; one
  request at a time per fan with priorities, bounded answers read as
  untrusted data, the owner e-mail never read; no timers, schedule, away mode,
  pairing, reboot nor reset; no generation 4 (`/device`, `/fixture`).

```
MIT License

Copyright (c) 2019-2020 Brian Towles

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
