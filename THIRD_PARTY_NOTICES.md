# Third-party notices

Nothing but the Gladys SDK is installed at runtime. Parts of this
integration are a JavaScript port of the work below.

## pajgps-api

pajgps-api 0.4.1 (<https://github.com/Skipperro/pajgps-api>, read at commit
`38c354a` of 2026-09-19), a Python client of the PAJ GPS API, under the MIT
License. Ported to JavaScript in `src/paj/`: the API address, the login and
the renewal of the token (`pajgps_api.py`: `login`, `update_token`;
`pajgps_requests.py`: the bearer header, the renewal on HTTP 401), the paths
and parameters of the requests (`get_devices`, `get_all_last_positions`,
`get_custom_notifications`), the shapes of the answers and what has a
battery (`models/device.py`, `models/trackpoint.py`,
`models/notification.py`), the alert types (`alert_types.py`), and the
OpenAPI description of the API kept in its repository (`api-docs.json`), used
with made-up values in `test/`.

```
MIT License

Copyright (c) 2026 Skipperro

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

PAJ and PAJ GPS are trademarks of their owner; this integration is
unofficial and not affiliated with PAJ.

## LM1LC3N7/gladys-invoxia and LM1LC3N7/gladys-webuntis

The structure of the app (devices of GPS trackers, never a smaller device,
state budget, transport badges, the HTTP transport, the persistent state
with salted fingerprints, the pace kept across restarts, final refusals of
the login) and the test helpers follow these integrations of the same
author, under the Apache License 2.0 of this repository.
