# Third-party notices

This integration ports to JavaScript the logic of the project below for
talking to the SPC Web Gateway. Nothing of it is installed at runtime: it is
Python, this integration is JavaScript.

## pyspcwebgw

<https://github.com/pyspcwebgw/pyspcwebgw> (read at commit `3fac932`,
2025-11-17; version 0.7.0 on PyPI), licensed under the MIT License.

Ported in `src/spc/client.js`, `src/spc/parse.js`, `src/constants.js` and
`src/app.js`: the REST resources of the gateway (`/spc/panel`, `/spc/area`,
`/spc/zone`, by id, and `PUT /spc/area/<id>/<set|set_a|set_b|unset>`), the
`{ status, data }` envelope (a list of one for an area read by id, an object
for a zone), the codes of the area modes, zone inputs, zone statuses and zone
types, the SIA codes of the websocket that concern an area or a zone (and
`CL` / `OP` that refresh every area), the reading of the resource named by an
event, and the verified alarm (`BV`). The test fixtures of the fake gateway
come from its tests.

```
MIT License

Copyright (c) 2018 Martin Berg

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

## Home Assistant (`spc` integration)

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/spc>,
licensed under the Apache License 2.0 (the same as this integration). Used as
a reference only: the mapping of the area modes (part set A as "home", part
set B as "night"), of the zone types (alarm zone as motion, entry/exit as
opening, fire as smoke) and the configuration with the REST and websocket
addresses of the gateway. No code is copied.

## ws (runtime dependency)

<https://github.com/websockets/ws>, the websocket client used for the events
of the gateway, installed from npm with its own `LICENSE` file, licensed
under the MIT License:

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
