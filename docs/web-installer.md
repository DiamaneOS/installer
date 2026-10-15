# Web installer

`web/` installs a DiamaneOS image set from a Chromium-based browser over WebUSB. It is a fork of
GrapheneOS's web installer and runs the same steps as the image set's `flash-all.sh`
([install steps](install-steps.md)).

## What it does

- Reads the image set from a local folder. It downloads nothing and sends nothing.
- Checks each file it uses against the set's `SHA256SUMS` before the first write: every image the
  install or the fastbootd fallback writes, `build.json` and `flash-all.sh`.
- Takes the steps from `build.json` as the tools do, and refuses a set whose `flash-all.sh` lists
  other `fastboot` commands.
- Checks the phone before the first write, as `flash-all.sh` does: the product, the bootloader (not
  fastbootd), unlocked, and unlocked critical partitions when the set writes firmware.
- Asks the user to confirm that the phone does not run a newer Fairphone release than the set's
  firmware. The bootloader cannot report it.
- Copies an image's AVB footer to the end of a larger partition, as platform-tools `fastboot` does.
- Keeps a log without serial numbers for reports.

## Unlocking and locking

- **Unlock bootloader** runs `fastboot flashing unlock` and **Unlock critical partitions** runs
  `fastboot flashing unlock_critical`. The user confirms each on the phone, and each erases it.
- Both need `flashing get_unlock_ability` to report 1. Otherwise the installer asks the user to turn
  on OEM unlocking.
- **Lock bootloader** works only with a set whose `build.json` allows it: `never_lock` false and
  not signed with public test keys.
- It locks one domain per press, `lock_critical` first, then `lock`, and only while the phone
  reports unlock ability 1.

## When the phone stops answering

The FP6 bootloader stops answering when a reply to a command is cut off, and only a restart frees
it.

- The installer reads every reply to its end. fastboot.js gives up on a `getvar` after 10 seconds
  and leaves its read pending, so the installer replaces that call with one that waits.
- A USB transfer left unanswered for 60 seconds while flashing, 30 seconds for any other command or
  5 minutes for an unlock or lock counts as a dead bootloader.
- The installer then never closes the connection. It asks the user to hold Power and Volume down
  until the phone restarts into Fastboot Mode, and sends nothing more until the phone is a new USB
  device.

## When super stalls

The bootloader can stop answering after it has taken the first part of `super`, and the phone then
does not start until it is flashed again. Fairphone's own super image once stopped this way in a
test, while DiamaneOS's flashed right after.

- If the bootloader had accepted at least one part, the installer offers **Continue in fastbootd**.
  Any other stall or error stops the install and links to the recovery page.
- The user forces a restart into Fastboot Mode (Power and Volume down) and presses the button.
- The installer runs `reboot-fastboot`, writes every logical partition to slot a in fastbootd,
  runs `reboot-bootloader`, then the steps that follow `super`.
- fastbootd is a new USB device to the browser, so the user may have to choose the phone again.
- The steps before `super` stay done. If the page was closed, the user runs the whole install again.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `js/install.js` | The page and its script, from GrapheneOS's `web.html` and `web-install.js` |
| `recovery.html` | What to do when an install fails |
| `js/package.js` | Reads `build.json`, `SHA256SUMS` and `flash-all.sh`, builds the steps |
| `js/flow.js` | The fastboot steps, the dead bootloader watchdog and the fastbootd fallback |
| `js/hash.js`, `js/hash-worker.js`, `js/sha256.js` | SHA-256 of large files in workers |
| `js/fastboot/ffe7e270/` | GrapheneOS's fastboot.js build, unchanged ([NOTICE](../web/js/fastboot/ffe7e270/NOTICE)) |
| `nginx/` | The security headers, and an example of where each set applies |
| `serve.py` | A local server for tests, with the same headers |
| `test/` | Node tests and a fixture made with the tools' `flash_all.py` |

## Security headers

`nginx/base.conf` goes on every response. `nginx/installer.conf` goes on the installer page and
`nginx/general.conf` on every other file. They follow GrapheneOS's headers, with these differences:

- No `connect-src`: the installer makes no network requests.
- `worker-src 'self'` instead of `child-src 'self'`, for the hash workers.
- Trusted Types on the installer page too, with one policy that only creates the hash worker's URL.
- HSTS as the website sends it: host-only, without preload.

No analytics, fonts or files from other hosts.

## Testing locally

- `python3 web/serve.py` serves the installer on <http://localhost:8780/> with the headers.
  Browsers allow WebUSB on localhost without a certificate.
- `node --test web/test/installer.test.mjs` runs the tests. They need no phone.
- After a change to `flash_all.py` in the tools, run `python3 web/test/make-fixture.py <tools
  checkout>` and the tests again.

## Upstream

- Forked from [grapheneos.org](https://github.com/GrapheneOS/grapheneos.org) at
  `0299c978e9b9f3c841498f7291c8ae901bc4d831`: `static/install/web.html`, `static/js/web-install.js`
  and `static/js/fastboot/ffe7e270/fastboot.min.mjs` with its source map.
- fastboot.js is GrapheneOS's fork at `ffe7e270061b95fe0f0f3abd1aa7d3c28999d1d9`.
- The Pixel parts are gone: the release download, the factory zip flash and the custom AVB key
  removal.
- GrapheneOS's licence and notices are in [web/LICENSE](../web/LICENSE) and the fastboot.js
  [NOTICE](../web/js/fastboot/ffe7e270/NOTICE).
