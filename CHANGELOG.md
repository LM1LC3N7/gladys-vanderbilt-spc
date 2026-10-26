# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-26

### Added

- First version: a Vanderbilt SPC panel through the SPC Web Gateway of
  Lundix (REST and websocket on port 8088), ported from pyspcwebgw. Each
  area becomes a device (mode, armed, alarm; buttons full set, part set A,
  part set B, unset), each zone another (state by kind, trouble, inhibited or
  isolated, alarm), plus the link to the gateway. Read every minute, events
  live through the websocket.
- Setting an area is the protective command: no option, no read before,
  not behind a read, the waits after failed reads nor a refusal of the
  credentials kept (one try per press); tried again every 250 ms within
  3.5 s while it does not reach the gateway, confirmed by a read of the area.
  A set the gateway accepted is not sent a second time (someone inside may
  have cancelled it at the keypad), except once when an older unset of
  Gladys still in flight at the press overtook it and nothing moved at the
  panel since its answer; one that never reached it is sent again only on a
  fresh read (started after the press) showing nothing moved at the panel,
  within 2 minutes.
  A part set is not sent over a full set read at that moment.
- Unsetting is off by default (option), needs the serial number of the
  panel read in this session, is decided on a fresh read, at most 6 per area
  per minute.
- Optional gateway credentials, sent only when asked: Digest; Basic only
  with its option (password readable on the network), never after Digest
  worked. A refusal is kept in `/data` as an 8-bit marker and the reads are
  not tried again by themselves.
- Unsetting counts as in flight from its decision: a set pressed before its
  connection is up withdraws it.
- The serial number of the panel is kept: another panel at the address stops
  everything until "Use the panel that answers".
- "Test the connection" and "Use the panel that answers" buttons;
  documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-vanderbilt-spc/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-vanderbilt-spc/releases/tag/v0.1.1
