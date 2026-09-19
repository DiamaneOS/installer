# DiamaneOS installer

Installation and recovery tooling for DiamaneOS, currently under development.

## Contents and status

The repository currently contains the
[draft Fairphone 6 stock recovery preflight](docs/recovery-preflight.md). It records source
references, prerequisites and stop conditions for validating recovery on the
actual device. It is not a validated installation procedure for DiamaneOS.

The planned CLI and WebUSB installers will share an installation and recovery
behavior contract. Neither installer is implemented in this repository yet.

The current preflight is device-specific but host-portable: it relies on the
official Android platform tools, exact content hashes and device identity, not
on a maintainer's workstation paths or USB topology. It deliberately does not
turn unvalidated destructive steps into a copy-and-paste installation recipe.
Private serials, backups, account state and execution evidence stay outside
this public repository.

## Licence

Original DiamaneOS code and documentation in this repository are licensed
under [Apache-2.0](LICENSE), except where another licence is identified.
See [NOTICE](NOTICE) for attribution. Referenced upstream software retains
its own licences; this repository's licence does not relicense those works.
