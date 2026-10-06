# DiamaneOS installer

Installation and recovery tooling for DiamaneOS, in development. No installer
is implemented in this repository.

## Contents

- The [draft Fairphone 6 stock recovery preflight](docs/recovery-preflight.md):
  source references, prerequisites and stop conditions for validating recovery
  on the actual device. It is not a validated DiamaneOS installation procedure.
- It is device-specific but host-portable: it relies on the official Android
  platform tools, exact content hashes and device identity, not on a
  maintainer's workstation paths or USB topology.
- It deliberately does not turn unvalidated destructive steps into a
  copy-and-paste installation recipe.
- Private serials, backups, account state and execution evidence stay out of
  this public repository.

## Licence

Original DiamaneOS code and documentation here are licensed under
[Apache-2.0](LICENSE), unless another licence is stated; attribution is in
[NOTICE](NOTICE). Referenced upstream software keeps its own licences; this
repository's licence does not relicense those works.
