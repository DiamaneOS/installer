# Install steps: web and command line

The web installer and the image set's `flash-all.sh` run the same clean install. This note lists
what they share and where they differ, so that a change to one reaches the other.

## The order

Both take the steps from the set's `build.json`, as `flash_all.commands()` in diamaneos-tools does:

1. `firmware.steps`: the device maker's firmware, both slots of each A/B partition, in the stock order.
2. `firmware.reset`: the empty modem file system images (`modemst1`, `modemst2`).
3. When `flash.logical` is not empty: `snapshot-update cancel`, only if `getvar
   snapshot-update-status` reports something other than `none`, as `fastboot flashall` and
   fastboot.js do.
4. `flash.bootloader` to slot a: boot, init_boot, vendor_boot, recovery, dtbo, pvmfw, vbmeta_system
   and vbmeta.
5. When `flash.logical` is not empty: `reboot fastboot`, then in fastbootd `wipe-super
   super_empty.img` and each logical partition to slot a, in that order, then `reboot-bootloader`.
6. `wipe.images` in key order: frp, metadata, misc and userdata.
7. With `never_lock: false` and a key file in `avb_custom_key`: `flash avb_custom_key <file>`,
   `--set-active=a`, then `reboot-bootloader`. The phone waits in the bootloader for the lock.
8. Otherwise `--set-active=a`, then `reboot`. A set with `never_lock: true` never gets a key.

Recovery, which holds fastbootd, is among the boot images in step 4. Nothing writes `super.img`
from the bootloader, which can stall while it writes it.

## Checks before the first write

| Check | `flash-all.sh` | Web installer |
| --- | --- | --- |
| The phone | `getvar product` is the set's product | the same, and the product is in `js/devices.js` |
| Bootloader, not fastbootd | `getvar is-userspace` is `no` | the same |
| Unlocked | `getvar unlocked` is `yes` | the same |
| Critical partitions, if it writes firmware | `oem device-info` | the same |
| Files | `sha256sum -c SHA256SUMS`, every file | every file it uses |
| No newer stock release on the phone | a warning in the output | a box to tick |
| Its own steps | none | the same as the set's `flash-all.sh` |
| The key signs `vbmeta.img` | none | refuses the set otherwise |

## Between the bootloader and fastbootd

- `flash-all.sh` waits until `getvar is-userspace` reports the new mode. It stops after 90 answers
  from the old mode, two seconds apart.
- The web installer waits for the phone to leave and come back, then checks the mode, the product
  and, in the bootloader, the unlock state.

## Differences that remain

- **Unlocking and locking:** `flash-all.sh` never unlocks or locks. It prints the lock command for
  a set with a key. The web installer has buttons for both, with the checks in
  [web installer](web-installer.md#locking). Neither ever locks the critical partitions.
- **Files:** the web installer needs only the files it uses, not `target-files.zip` or `otatools.zip`.
- **Empty super layout:** `fastboot wipe-super` writes the metadata of `super_empty.img` from the
  computer. The web installer uploads the file and sends `update-super:super:wipe`, as `fastboot
  flashall` does. Both leave an empty layout for the logical partitions.
- **fastboot:** the web installer uses fastboot.js. It turns a raw image larger than one part into a
  sparse one without skipping empty blocks, so such an image sends more data than with
  platform-tools.

## Keeping them in step

- A change to `flash_all.py` (the order or the checks) needs the same change in `web/js/package.js`
  (`installSteps`, `checks`).
- The web installer refuses a set whose `flash-all.sh` lists other `fastboot` commands than its own
  steps. A missed change stops installs instead of changing them.
- `web/test/fixture` is made with the tools' `flash_all.py`. Make it again after a change there (see
  [testing](web-installer.md#testing-locally)).
