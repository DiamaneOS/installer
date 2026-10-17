# Web installer

`web/` installs a DiamaneOS image set from a Chromium-based browser over WebUSB. It is a fork of
GrapheneOS's web installer and runs the same steps as the image set's `flash-all.sh`
([install steps](install-steps.md)).

## What it does

- Reads the image set from a local folder. It downloads nothing and sends nothing.
- Checks each file it uses against the set's `SHA256SUMS` before the first write: every image the
  install writes, `build.json` and `flash-all.sh`.
- Takes the steps from `build.json` as the tools do, and refuses a set whose `flash-all.sh` lists
  other `fastboot` commands.
- Refuses a set whose AVB key (`avb_custom_key` in `build.json`) does not sign its own `vbmeta.img`.
  A phone locked with that key would not start.
- Checks the phone before the first write, as `flash-all.sh` does: the set's product, the bootloader
  (not fastbootd), unlocked, and unlocked critical partitions when the set writes firmware.
- Refuses a set for a product that `DEVICES` in `js/package.js` does not list, and unlocks only a
  phone whose product it lists. A new device is one entry there.
- Asks the user to confirm that the phone does not run a newer stock release than the set's
  firmware. The bootloader cannot report it.
- Copies an image's AVB footer to the end of a larger partition, as platform-tools `fastboot` does.
- Keeps a log without serial numbers for reports.

## Unlocking

- **Unlock bootloader** runs `fastboot flashing unlock` and **Unlock critical partitions** runs
  `fastboot flashing unlock_critical`. The user confirms each on the phone, and each erases it.
- Both need `flashing get_unlock_ability` to report 1. Otherwise the installer asks the user to turn
  on OEM unlocking.
- After an unlock the phone may start Android. The user turns it off and returns it to Fastboot
  Mode. An Android start after the first unlock turns OEM unlocking off, and the critical unlock is
  then refused.

## Locking

A set may be locked when `build.json` has `never_lock: false` and names a key in
`avb_custom_key`. Its install ends with `flash avb_custom_key`, the checked slot and
`reboot-bootloader`, so the phone waits in the bootloader. **Lock bootloader** then:

1. Is offered only on the connection the install ended on. A restart or a disconnect after the
   install ends the offer, because Android might have started. Another install starts it again.
2. Checks that the phone reports the set's product, is in the bootloader, still unlocked, reports
   its critical lock state, and that `flashing get_unlock_ability` reports 1.
3. Sends `fastboot flashing lock_critical`, once, after the user's click. The user confirms on the
   phone and holds the key `DEVICES` names while it restarts.
4. Waits for the phone to come back to the bootloader, with the Connect again button. If it is not
   back within two minutes, for example because Android started, the installer stops and leaves the
   bootloader unlocked.
5. Checks the phone again as in step 2, and that the critical partitions are now locked.
6. Sends `fastboot flashing lock`, once. The user confirms on the phone.
7. Waits for the phone to restart. If it comes back to Fastboot Mode, the installer checks that
   `getvar unlocked` reports `no`.
8. If the phone starts Android instead, the installer says how to read the warning screen: yellow
   when locked, orange when still unlocked.

- This is the stock relock order, which `flash-all.sh` prints. Android must not start between the
  two locks.
- When the critical partitions are already locked, steps 3 to 5 are skipped.
- The installer never locks a set with `never_lock: true`. The gate is the record, not the name of
  the signing keys.

## When the phone stops answering

The bootloader stops answering when a reply to a command is cut off, and only a restart frees it.

- The installer reads every reply to its end. fastboot.js gives up on a `getvar` after 10 seconds
  and leaves its read pending, so the installer replaces that call with one that waits.
- A USB transfer left unanswered for 60 seconds while flashing, 30 seconds for any other command or
  5 minutes for an unlock or lock counts as a dead bootloader.
- The installer then never closes the connection. It asks the user to restart the phone into
  Fastboot Mode with the buttons `DEVICES` names for it, and sends nothing more until the phone
  is a new USB device.

## fastbootd

The bootloader can stall while it writes `super.img`, so the logical partitions are written in
fastbootd instead.

- Before the boot images it cancels an update the OS left pending, if `getvar
  snapshot-update-status` reports one.
- After the boot images the installer selects `flash.slot` and checks that `getvar current-slot`
  reports exactly that slot. Then it runs `reboot-fastboot`.
- Once the phone is back, it checks that it is in fastbootd and is the same product.
- It writes the empty layout from `super_empty.img`, then each logical partition to `flash.slot`.
- It runs `reboot-bootloader` and checks the product, the bootloader and the unlock state again
  before the data images.
- fastbootd is a new USB device to the browser, so the user may have to choose the phone again.
- A stall or an error stops the install and links to the recovery page. The user runs the whole
  install again.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `js/install.js` | The page and its script, from GrapheneOS's `web.html` and `web-install.js` |
| `recovery.html` | What to do when an install or a lock fails |
| `stock.html` | Returning to the device maker's stock OS and locking it there |
| `style.css`, `fonts/` | The website's look, with its Sofia Sans font ([licence](../web/fonts/OFL.txt)) |
| `js/package.js` | The supported devices (`DEVICES`). Reads `build.json`, `SHA256SUMS` and `flash-all.sh`, builds the steps |
| `js/flow.js` | The fastboot steps, the dead bootloader watchdog, the switches to fastbootd and back, and the lock |
| `js/hash.js`, `js/hash-worker.js`, `js/sha256.js` | SHA-256 of large files in workers |
| `js/fastboot/ffe7e270/` | GrapheneOS's fastboot.js build, unchanged ([NOTICE](../web/js/fastboot/ffe7e270/NOTICE)) |
| `nginx/` | The security headers, and an example server for the installer's own host |
| `serve.py` | A local server for tests, with the same headers |
| `test/` | Node tests and two fixtures made with the tools' `flash_all.py` |

## Security headers

`nginx/base.conf` goes on every response. `nginx/installer.conf` goes on the installer page and
`nginx/general.conf` on every other file. They follow GrapheneOS's headers, with these differences:

- No `connect-src`: the installer makes no network requests.
- `worker-src 'self'` instead of `child-src 'self'`, for the hash workers.
- Trusted Types on the installer page too, with one policy that only creates the hash worker's URL.
- HSTS as the website sends it: with subdomains, without preload.

No analytics, fonts or files from other hosts. [Hosting](hosting.md) describes the server.

## Testing locally

- `python3 web/serve.py` serves the installer on <http://localhost:8780/> with the headers.
  Browsers allow WebUSB on localhost without a certificate.
- `node --test web/test/installer.test.mjs` runs the tests. They need no phone.
- `test/fixture` must never be locked. `test/fixture-relock` installs a key and stops for the lock.
  `test/flash-all-commands.json` holds the steps `flash_all.commands()` returns for each.
- After a change to `flash_all.py` in the tools, run `python3 -B web/test/make-fixture.py <tools
  checkout>` and the tests again.

## Upstream

- Forked from [grapheneos.org](https://github.com/GrapheneOS/grapheneos.org) at
  `0299c978e9b9f3c841498f7291c8ae901bc4d831`: `static/install/web.html`, `static/js/web-install.js`
  and `static/js/fastboot/ffe7e270/fastboot.min.mjs` with its source map.
- fastboot.js is GrapheneOS's fork at `ffe7e270061b95fe0f0f3abd1aa7d3c28999d1d9`.
- The Pixel parts are gone: the release download, the factory zip flash and the custom AVB key
  removal. The stock page lists the key removal as a command.
- GrapheneOS's licence and notices are in [web/LICENSE](../web/LICENSE) and the fastboot.js
  [NOTICE](../web/js/fastboot/ffe7e270/NOTICE).
