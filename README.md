# DiamaneOS installer

Installation and recovery tools and documentation for DiamaneOS.

## Contents

- The [web installer](docs/web-installer.md) in `web/`: downloads a release or reads an image set,
  installs it from a Chromium-based browser over USB and locks the bootloader after it when the set
  allows that.
  - A [page for failed installs](web/recovery.html) and a guide for
    [returning to the stock OS](web/stock.html).
  - [Hosting](docs/hosting.md): the host name, headers and deploy steps it needs.
- [Install steps](docs/install-steps.md): how the web installer and the image set's `flash-all.sh`
  match, and how to keep them in step.

## Licence

Original DiamaneOS code and documentation here are licensed under
[Apache-2.0](LICENSE), unless another licence is stated. `web/` is a fork of
GrapheneOS's web installer and keeps its MIT licence ([web/LICENSE](web/LICENSE)).
Attribution is in [NOTICE](NOTICE). Referenced upstream software keeps its own
licences.
