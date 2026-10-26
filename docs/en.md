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
arrive live through the websocket of the gateway (a zone that opens shows
within a second).

> **This integration has never been tested with a real panel.** This first
> version was written from the pyspcwebgw library and the `spc` integration
> of Home Assistant, and tested only against a fake gateway. Tell on the
> Gladys forum what works and what does not.

Unofficial integration, not affiliated with Vanderbilt nor Lundix.

## Configuration

- **Address of the SPC Web Gateway**: the IP address of the computer that
  runs it (`192.168.1.10`); a port may follow (`192.168.1.10:8088`, 8088 by
  default). Prefer the IP address (a `.local` name does not resolve inside the
  container of the integration) and give it a fixed address in your router.
  The integration talks plain http to the gateway on your network: keep the
  gateway on your local network. The websocket is `ws://<address>/ws/spc`.
- **User name / password of the gateway**: only if your gateway asks for
  them; leave both empty otherwise. They are sent only to the gateway, and
  only when it asks (it answers 401 with a challenge): Digest when it offers
  it (the password itself never travels), else Basic. The password is kept by
  Gladys in its database, never shown again, never in the logs. A password
  refused by the gateway stops the integration (no new try by itself, even
  after a restart) until you enter other credentials or press **Test the
  connection** (one try). The integration remembers that refusal with an
  8-bit marker only, from which no password can be found back.
- **Allow unsetting (disarming) from Gladys**: off by default. See below.
- **Zone kinds** (optional): how some zones show, by their number, e.g.
  `5:opening, 12:motion` (opening, motion, smoke, leak, input). By default the
  type of the zone on the panel decides: alarm zone: motion (as Home
  Assistant), entry/exit: opening, fire: smoke, water: leak, the others:
  input; unused zones are not shown. A kind changed for a zone already created
  shows after **Update** in the Discovery tab (until then its states go to the
  feature it has). Entries not understood are counted in the status, never
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
gateway fail and wait, and while a read is running (it has its own
connection; a read that received nothing for 1 s is cut). Pressing it
withdraws the unset commands of the same area that have not left yet.

Its request is tried again every 250 ms until 3.5 s after the press, then
the area is read back until 4.3 s:

- the area shows the mode: done;
- the gateway accepted it, but the area does not show it yet (the panel may
  be in its exit time): Gladys answers "sent and accepted, not yet shown",
  and the area is read again 5, 20 and 60 s later;
- the request did not reach the gateway: Gladys answers so.

A set not seen applied is **kept** (also across a restart, 10 minutes at
most) and sent again, **3 times at most**: at the next read when it never
reached the gateway, once an unset command of Gladys that was in flight when
it was pressed may have landed after it, after a restart, and at the 60 s read
when the area still does not show it. It is not sent again when the area
shows it, when the area was set then unset by someone else (its last set time
moved; the panel does not report this time for part sets, so a part set unset
at the keypad within that minute may be sent again once), or when an unset
command of Gladys asked after it has left.

A **part set** never lowers a full set (nothing is sent: the area stays fully
set) and never replaces the other part set (refused: full set, or unset
first). To know it, a part set reads the area first (1.2 s at most); when that
read fails, it is sent only if the last state read was "unset". A full set is
not held back by this.

Setting is **refused** in these cases only:

- the address is missing or not valid, or the configuration changed while
  the command was running;
- the gateway refused the credentials, asks for credentials none were given
  for, or asks for an authentication the integration does not know;
- another panel answers at the address (see below);
- a part set while the area is in the other part set;
- a part set while the state of the area can be read neither now nor from the
  last read ("unset");
- earlier sets of the same area took its whole time (3.5 s).

The panel itself may also refuse it (a zone open or in fault, for instance):
Gladys then says "refused by the panel" and does not send it again.

### Unsetting (disarming)

Off unless you tick **Allow unsetting (disarming) from Gladys**. Then an
unset command:

- is refused while the serial number of the panel has not been read since the
  start of the integration (a read every minute);
- reads the area and the serial number of the panel first (by 2.5 s) and
  decides on what it reads: the serial unreadable or another one, nothing is
  sent; the area unreadable,
  nothing is sent; already unset, nothing is sent, unless a set of Gladys may
  still apply;
- checks the option and the set commands asked meanwhile again right before
  its request (a set asked after it withdraws it);
- at most 6 per area and per minute, one at a time per area;
- is confirmed by a read of the area (by 4.3 s), else Gladys says "sent, not
  yet shown" or "sent, no answer" and the area is read again 5 and 20 s later.

## Identity of the panel

The serial number of the panel is learnt at the first read and kept. If
another panel answers later at the same address (a DHCP change, another
gateway), nothing is published nor sent, and the status shows the serial
number met. If it is yours (a panel replaced), press **Use the panel that
answers**.

## Status and buttons

- The status of the integration tells whether the gateway answers, the
  number of areas and zones, whether the events arrive live, and why not.
- **Test the connection**: reads the configuration again, makes one try
  despite refused credentials (at most every 10 s), reads the gateway when
  the pace allows it (never more than once a minute), then reports.
- Failed reads are tried again every minute at first, then 2, 4 and 5
  minutes apart; the websocket
  15 s to 5 min later. A websocket refused by the gateway (401) is not tried
  again until the configuration changes: the reads every minute go on.

## Limits

- Never tested with a real panel or gateway (see above).
- The path of the websocket (`/ws/spc`) and the authentication of the gateway
  (Digest or Basic, only when asked) are those documented around Home
  Assistant and pyspcwebgw, not checked on a real gateway.
- No outputs, no zone inhibition or isolation, no event log in this version.
- Values older than 2.5 minutes are not published (the link shows off).
