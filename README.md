# DiamaneOS installer

Installation and recovery tools and documentation for DiamaneOS.

## Contents

- The [web installer](docs/web-installer.md) in `web/`: installs an image set from a Chromium-based
  browser over USB and locks the bootloader after it when the set allows that.
  - A [page for failed installs](web/recovery.html) and a guide for
    [returning to the stock OS](web/stock.html).
- [Install steps](docs/install-steps.md): how the web installer and the image set's `flash-all.sh`
  match, and how to keep them in step.
- The [Fairphone 6 stock recovery preflight](docs/recovery-preflight.md):
  source references, prerequisites and stop conditions for unlocking the
  bootloader, restoring the stock OS and relocking.
  - It covers the stock OS. It is not a DiamaneOS installation procedure.
  - It is a checklist with stop conditions, not a copy-and-paste recipe.
  - It is device-specific but host-portable: it relies on the official Android
    platform tools, exact content hashes and device identity.

## Licence

Original DiamaneOS code and documentation here are licensed under
[Apache-2.0](LICENSE), unless another licence is stated. `web/` is a fork of
GrapheneOS's web installer and keeps its MIT licence ([web/LICENSE](web/LICENSE)).
Attribution is in [NOTICE](NOTICE). Referenced upstream software keeps its own
licences.
