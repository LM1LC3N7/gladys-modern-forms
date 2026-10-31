# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Modern Forms and WAC smart ceiling fans (generations 1 to 3) through their
  local HTTP API (`POST /mf`), up to 8 fans: fan speed (0 = off, 1 to 6),
  direction, breeze mode (generation 3), light and brightness; Discover lists
  each fan read, named as in the app.
- Offs (fan speed 0, light off, brightness 0) go first, without any option,
  during a pause, before the configuration is read (address known) and before
  the first read; kept in `/data` and sent again until a read shows them.
- "Test the connection".
- French and English guides.
