# Vanderbilt SPC

Your **Vanderbilt SPC** alarm panel (formerly Siemens SPC) in Gladys, through
the **SPC Web Gateway** of Lundix (a separate software, installed on a
computer of your network, which talks to the panel), without any cloud:

- each **area** of the panel becomes a Gladys device: **mode** (unset, part
  set A, part set B, full set, alarm), **armed**, **alarm**, and four
  **buttons**: full set, part set A, part set B, unset;
- each **zone** becomes another: its **state** (opening, motion, smoke, water
  leak or plain input), **trouble** (tamper, fault, short, cut, masked,
  offline), **inhibited or isolated**, **alarm**;
- the **link** to the gateway.

The areas and zones are read every minute, and the events of the panel
arrive through the websocket of the gateway (while it is open, a zone that
opens usually shows within a second).

> **This integration has never been tested with a real panel.** This first
> version was written from the pyspcwebgw library and the `spc` integration
> of Home Assistant, and tested only against a fake gateway. Several points
> are assumptions, listed under "Limits". Tell on the Gladys forum what works
> and what does not.

Unofficial integration, not affiliated with Vanderbilt nor Lundix.

> **False alarm.** Setting an area while someone is inside (a scene set
> wrongly, a press by mistake) can raise a false alarm: sirens, and a call of
> your monitoring company if you have one.

## Configuration

- **Address of the SPC Web Gateway**: the IP address of the computer that
  runs it (`192.168.1.10`); a port may follow (`192.168.1.10:8088`, 8088 by
  default). Prefer the IP address (a `.local` name does not resolve inside the
  container of the integration) and give it a fixed address in your router.
  The integration talks plain http to the gateway on your network: keep the
  gateway on your local network. The websocket is assumed at
  `ws://<address>/ws/spc` (not checked on a real gateway).
- **User name / password of the gateway**: only if your gateway asks for
  them; leave both empty otherwise. They are sent only to the gateway, and
  only when it asks (it answers 401 with a challenge): Digest when it offers
  it (the password itself does not travel). The password is kept by Gladys in
  its database, never shown again, never in the logs. A password refused by
  the gateway stops the reads (no new read by itself, even after a restart)
  until you enter other credentials or press **Test the connection** (one
  try); a set still makes one try per press, and a success lifts the stop.
  The integration remembers that refusal with an 8-bit marker only, from
  which no password can be found back.
- **Allow Basic authentication**: off by default. With Basic, the user name
  and the password are **readable by anyone listening on your local network,
  at every read** (every minute), and they can unset the alarm. Without this
  option, a gateway that asks for Basic gets nothing and the status says so.
  Once Digest worked with the gateway, a later request for Basic is not
  answered (another device at the address could be reading the password):
  the reads stop and the status says so, until you check the gateway and
  press **Test the connection**.
- **Allow unsetting (disarming) from Gladys**: off by default. See below.
- **Zone kinds** (optional): how some zones show, by their number, e.g.
  `5:opening, 12:motion` (opening, motion, smoke, leak, input). By default the
  type of the zone on the panel decides: alarm zone: motion (as Home
  Assistant), entry/exit: opening, fire: smoke, water: leak, the others:
  input; unused zones are not shown. A kind changed for a zone already created
  shows after **Update** in the Discovery tab (until then its states go to the
  feature it has). Entries not understood are counted in the status, not
  shown back.
- **Language of the devices**: names of the features and modes, and of the
  areas and zones without a name on the panel.

The devices appear in the **Discovery** tab once the gateway was read.

## Commands

Every command is a **button** (never a switch): "turn everything off", a
voice assistant or a scene on switches cannot unset the alarm.

### Setting (full set, part set A, part set B)

Setting is the protective command. It needs no option and no read made
before: it works from the start of the integration, while the reads of the
gateway fail and wait, while a read is running (it has its own connection; a
read that received nothing for 1 s is cut) and while a refusal of the
credentials is kept (one try per press). Pressing it withdraws the unset
commands of the same area that have not left yet, including one whose
connection is not up yet.

Its request is tried again every 250 ms until 3.5 s after the press while it
does not reach the gateway (on an HTTP 5xx answer, one more try only), then
the area is read back until 4.3 s:

- the area shows the mode: done;
- the gateway accepted it, but the area does not show it yet: Gladys answers
  "sent and accepted, not yet shown", and the area is read again 5, 20 and
  60 s later. **It is not sent a second time**: the panel may be in its exit
  time, a zone may be open, or someone inside may have cancelled it at the
  keypad. If the area still does not show it after 60 s, the status of the
  integration says so;
- the gateway answered an HTTP error 4xx: "refused by the gateway", not sent
  again; it reports a failure (`status` other than success) and the area
  does not show the mode: "refused by the panel";
- the request did not reach the gateway (or got no valid answer): Gladys
  says so. It is sent again (3 times at most, within **2 minutes** of the
  press, also after a restart) only on a fresh read of the area that shows it
  exactly as it was read before the press (mode, last set time, last unset
  time; that read less than 150 s before the press) and with no set or unset
  event of the panel since the press. Otherwise it is dropped and the status
  says to set again.

A set pressed while an unset of Gladys of the same area is already on the
wire may be overtaken by it: once that unset is answered, the area is read
again and the set is sent again once if the area does not show it.

A **part set** is not sent over a full set read at that moment (nothing is
sent: the area stays fully set) and not over the other part set (refused:
full set, or unset first). To know it, a part set reads the area first
(1.2 s at most); when that read fails, it is sent only if the last state read
was "unset" (which may be up to a minute old), and while an unset of Gladys of
the area is uncertain it is sent without this check. A full set is not held
back by this.

Setting is **refused** in these cases only:

- the configuration of Gladys is not read yet (asked again), the address is
  missing or not valid, or the configuration changed while the command was
  running;
- the gateway asks for credentials none were given for, asks for Basic while
  it is not allowed (or after Digest worked), or for an authentication the
  integration does not know;
- another panel answers at the address (see below);
- a part set while the area is in the other part set;
- a part set while the state of the area can be read neither now nor from the
  last read ("unset");
- earlier sets of the same area took its whole time (3.5 s);
- an unset of Gladys asked after it left first.

The gateway or the panel may also refuse it (HTTP error, failure reported, a
zone open): Gladys then says so.

### Unsetting (disarming)

Off unless you tick **Allow unsetting (disarming) from Gladys**.

> **No code is asked.** Once the option is ticked, any user of Gladys, any
> scene, the mobile app and a dashboard on a tablet at the entrance can unset
> an area. Do not put the unset button on a dashboard reachable from the
> entrance.

Then an unset command:

- is refused while the serial number of the panel has not been read since the
  start of the integration (a read every minute);
- reads the area and the serial number of the panel first (by 2.5 s) and
  decides on what it reads: the serial unreadable or another one, nothing is
  sent; the area unreadable, nothing is sent; already unset, nothing is sent,
  unless a set of Gladys may still apply;
- checks the option and the set commands asked meanwhile again right before
  its request (a set asked after it withdraws it, also while its connection
  is not up yet);
- at most 6 per area and per minute, one at a time per area;
- is confirmed by a read of the area (by 4.3 s), else Gladys says "sent, not
  yet shown" or "sent, no answer" and the area is read again 5 and 20 s later.
  It is not sent again by itself.

## Identity of the panel

The serial number of the panel is learnt at the first read and kept, and
read again at every read. If another panel answers later at the same address
(a DHCP change, another gateway), nothing is published nor sent, and the
status shows the serial number met. If it is yours (a panel replaced), press
**Use the panel that answers**.

## Status and buttons

- The status of the integration tells whether the gateway answers, the
  number of areas and zones, whether the events arrive live (and the HTTP
  status of the websocket when it is refused), the use of Basic, and what
  became of a set that is not shown.
- **Test the connection**: reads the configuration again, makes one try
  despite refused credentials (at most every 10 s), forgets that Digest
  worked (Basic still needs its option), reads the gateway when the pace
  allows it (not more than once a minute), then reports.
- Failed reads are tried again every minute at first, then 2, 4 and 5
  minutes apart; the websocket 15 s to 5 min later. A websocket refused by
  the gateway's authentication (401) is not tried again until the
  configuration changes: the reads every minute go on.

## Limits

- Not tested with a real panel or gateway (see above). These points are
  assumptions taken from Home Assistant and pyspcwebgw, to be checked:
  - the path of the websocket (`/ws/spc`) and the authentication of the
    gateway (Digest or Basic, only when asked);
  - what an area reads during the exit time of a set;
  - the answer of the gateway to a set refused by the panel (a zone open):
    `{ "status": "failed" }`, an HTTP error, or a success without effect;
  - whether the last set time of an area moves for a part set;
  - the answer to a set on an area already fully set;
  - the serial number (`sn`) of the panel on every firmware;
  - the size of the list of zones with 512 zones (1 MB at most is read).
- No outputs, no zone inhibition or isolation, no event log in this version.
- Values older than 2.5 minutes are not published (the link shows off).
