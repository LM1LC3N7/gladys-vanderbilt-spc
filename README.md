# gladys-vanderbilt-spc

[Gladys Assistant](https://gladysassistant.com) external integration for
**Vanderbilt SPC** alarm panels (formerly Siemens SPC) through the **SPC Web
Gateway** of Lundix (REST and websocket on your network, port 8088): each
area becomes a Gladys device (mode, armed, alarm, and buttons full set, part
set A, part set B, unset), each zone another (state, trouble, inhibited or
isolated, alarm). Setting needs no option and does not wait for the periodic
reads (a part set reads its area first); a set the gateway accepted is not
sent a second time; unsetting is off by default. Local, no cloud. **Unofficial integration, not
affiliated with Vanderbilt nor Lundix. Never tested with a real panel yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (SpcApp)
                 ├─ src/spc/client.js   REST: /spc/panel, /spc/area, /spc/zone, PUT /spc/area/<id>/<cmd>
                 ├─ src/spc/http.js     one request, its own connection (node:http), bounded
                 ├─ src/spc/auth.js     Digest / Basic, only in answer to a 401 challenge
                 ├─ src/spc/events.js   the websocket /ws/spc (`ws`, bounded messages)
                 ├─ src/spc/parse.js    answers and events -> plain objects (from pyspcwebgw)
                 ├─ src/publisher.js    states per minute (300/min limit of Gladys)
                 ├─ src/store.js        /data: panel serial, last read, refusal marker, guards
                 └─ src/devices.js      panel, area and zone devices (pure)
```

- **Reads**: the areas (main resource), the panel serial (identity) and the
  zones every 60 s on a monotonic clock, never sooner after a
  restart, a reconnection, Discovery or the test button; failures retried
  1 to 5 min later. Values older than 150 s are not published.
- **Events**: the websocket pushes SIA codes; the area or zone named is read
  at once (one read per 250 ms, a burst reads everything, a flood closes the
  socket); ping every 30 s, reopened 15 s to 5 min later.
- **Set**: protective, its own connection, cuts a read silent for 1 s, tried
  again every 250 ms until 3.5 s while not delivered, confirmed by a read by
  4.3 s; accepted by the gateway: follow-up reads 5, 20, 60 s, never sent
  again (someone inside may have cancelled it); never delivered: sent again
  only on a fresh read showing nothing moved at the panel, within 2 min.
- **Unset**: option off by default, fresh read of the area and of the serial,
  6 per area per minute, withdrawn by a later set (even before it connects).
- **Credentials**: only on a 401 challenge; Digest, Basic only with its
  option, never Basic after Digest worked.
- External ids: `panel:spc`, `area:<id>`, `zone:<id>` (the numbers of the
  panel).

## Development

```bash
npm install
npm test              # node --test, against the SDK's fake Gladys and a fake gateway
npm run lint
npm run format:check
npm run cover         # cover.png
```

See [CLAUDE.md](CLAUDE.md) for the project rules and [TODO.md](TODO.md) for
the decisions and what is left.

## License

Apache-2.0 (see [LICENSE](LICENSE)); the logic ported from pyspcwebgw (MIT)
and the `ws` dependency (MIT) are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
