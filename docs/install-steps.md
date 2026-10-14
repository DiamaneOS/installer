# Install steps: web and command line

The web installer and the image set's `flash-all.sh` run the same clean install. This note lists
what they share and where they differ, so that a change to one reaches the other.

## The order

Both take the steps from the set's `build.json`, as `flash_all.commands()` in diamaneos-tools does:

1. `firmware.steps`: the Fairphone firmware, both slots of each A/B partition, in the stock order.
2. `firmware.reset`: the empty modem file system images (`modemst1`, `modemst2`).
3. `flash.bootloader` to slot a: boot, init_boot, vendor_boot, recovery, dtbo, pvmfw, vbmeta_system
   and vbmeta.
4. `super`, when `flash.logical` is not empty.
5. `wipe.images` in key order: frp, metadata, misc and userdata.
6. `--set-active=a`, then `reboot`.

## Checks before the first write

| Check | `flash-all.sh` | Web installer |
| --- | --- | --- |
| The phone | `getvar product` | the same |
| Bootloader, not fastbootd | `getvar is-userspace` is `no` | the same |
| Unlocked | `getvar unlocked` is `yes` | the same |
| Critical partitions, if it writes firmware | `oem device-info` | the same |
| Files | `sha256sum -c SHA256SUMS`, every file | every file it uses |
| No newer Fairphone release on the phone | a warning in the output | a box to tick |
| Its own steps | none | the same as the set's `flash-all.sh` |

## When super stalls

On a stall, `flash-all.sh` waits until the user stops it. `flash-steps` and the web installer give the same
fastbootd steps, after a forced restart into Fastboot Mode (Power and Volume down):

```sh
fastboot reboot fastboot
fastboot flash system_a system.img
fastboot flash system_ext_a system_ext.img
fastboot flash product_a product.img
fastboot flash vendor_a vendor.img
fastboot flash odm_a odm.img
fastboot flash vendor_dlkm_a vendor_dlkm.img
fastboot flash system_dlkm_a system_dlkm.img
fastboot reboot bootloader
fastboot flash frp frp.img
fastboot flash metadata metadata.img
fastboot flash misc misc.img
fastboot flash userdata userdata.img
fastboot --set-active=a
fastboot reboot
```

- The logical partitions are the set's `flash.logical`, in that order.
- Every one is written, because the stalled flash may already have written the new layout.
- The web installer offers them only when the bootloader had taken at least one part of `super`.

## Differences that remain

- **Unlocking and locking:** `flash-all.sh` never unlocks or locks. The web installer has buttons for
  both, with the checks in [web installer](web-installer.md#unlocking-and-locking).
- **Files:** the web installer needs only the files it uses, not `target-files.zip` or `otatools.zip`.
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
- A change to the fastbootd steps in `flash_steps.py` needs the same change in `fallbackSteps`.
