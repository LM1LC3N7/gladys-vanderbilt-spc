# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: a Vanderbilt SPC panel through the SPC Web Gateway of
  Lundix (REST and websocket on port 8088), ported from pyspcwebgw. Each
  area becomes a device (mode, armed, alarm; buttons full set, part set A,
  part set B, unset), each zone another (state by kind, trouble, inhibited or
  isolated, alarm), plus the link to the gateway. Read every minute, events
  live through the websocket.
- Setting an area is the protective command: no option, no read before,
  never behind a read nor the waits after failed reads; tried again every
  250 ms within 3.5 s, confirmed by a read of the area, kept and sent again
  (3 times at most, 10 minutes at most, across a restart) while the area
  does not show it. A part set never lowers a full set.
- Unsetting is off by default (option), needs the serial number of the
  panel read in this session, is decided on a fresh read, at most 6 per area
  per minute.
- Optional gateway credentials (Digest or Basic, only when asked); a refusal
  is kept in `/data` as an 8-bit marker and never tried again by itself.
- The serial number of the panel is kept: another panel at the address stops
  everything until "Use the panel that answers".
- "Test the connection" and "Use the panel that answers" buttons;
  documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-vanderbilt-spc/commits/main
