# FP6 Arrival and Stock Recovery Preflight

Status: FP6.QREL.16.100.0 EU stock restore, critical relock, normal relock,
locked-green boot and final cold-boot hardware checks validated on physical FP6
hardware on 2026-09-20. The procedure remains human-led and build-specific:
repeat every identity, integrity, AVB, rollback, slot and unlock-ability gate for
the exact target rather than treating this result as universal authorization.

Sources (retrieved 2026-09-10):
- Fairphone unlock/lock guide (2026-07-09):
  <https://support.fairphone.com/hc/en-us/articles/10492476238865-How-to-unlock-or-lock-your-Fairphone-s-bootloader>
- Fairphone bootloader-code page (toggle + online verification; ability `0` →
  support case): <https://www.fairphone.com/bootloader-unlocking-code-for-fairphone>
- LineageOS FP6 install wiki (Vol Down+Power, partition set):
  <https://wiki.lineageos.org/devices/FP6/install/>
- verified recovery-input inventory in `diamaneos-tools/config/stock-inputs.json`:
  the arrival snapshot was FP6.QREL.15.176.0. The official OTA was subsequently
  installed; the current accepted checkpoint is locked, green-verified EU
  Android 16 FP6.QREL.16.100.0 (security patch 2026-08-05). Its matching
  official factory package is the validated EU restore-selection input. The
  official final Android 15 package FP6.QREL.15.178.0 remains a historical
  verified input, not the current selection. Both archives reproduced their
  published SHA-256 twice. Private custody requires a separately verified
  independent copy before destructive work. The Android 16 EU archive was
  successfully restored and relocked through the procedure below. The Android
  15 archive remains an unexecuted recovery input. Archive selection alone does
  not prove rollback-index, AVB, slot or relock safety.

## Identity rule (every destructive phase)

Before any state-changing command, `fastboot devices` must show exactly the
serial privately recorded at arrival; on mismatch, multiple devices, or blank
output, stop. Keep serials in the operator-selected private evidence record outside public repositories.

## Brick rules (read first)

- Before EVERY `lock`/`lock_critical`: `fastboot flashing get_unlock_ability`
  must return `1`. On `0`, stop — do not lock, do not force, use the support
  path. Unlock-ability alone never authorizes relock.
- Relock needs the complete §4.1 checklist below on this exact device — variant
  + firmware, full compatible images, AVB chain, slots, rollback indices, and
  the `lock_critical`-then-`lock` order with Vol-Down reboot between.
- Two separate rollback rules (do not mix them):
  (a) Vendor patch rule: Fairphone warns that flashing an OS with an older
  security-patch date than the previously installed OS can brick on relock —
  compare patch dates, newest wins, never downgrade.
  (b) AVB index rule: each relevant authenticated VBMeta carries a
  rollback_index in its header; for chained partitions the chain descriptor
  supplies the index location. The bootloader compares each index against the
  matching stored location and refuses older values. Patch dates and stored
  indices are different kinds of values — both must independently allow the
  target; an unreadable index is a stop, never an assumption.
  Source: AOSP AVB README (Rollback Protection) and avb_vbmeta_image.h.
- `unlock` then `unlock_critical`, each wipes; `unlock_critical` fails with
  `Flashing Unlock is not allowed` unless the first unlock + on-screen approval
  completed and ability is `1`.

## §4.1 preflight checklist (all must be green before any relock)

1. Exact FP6 variant and firmware build recorded (About phone).
2. Complete compatible factory images + SHA256 verified (stock recovery archiving package).
3. AVB chain reviewed: vbmeta Flags `0` expected for verification on;
   Flags `3` boots unlocked but fails locked.
4. Slot topology and state known. For the validated EU factory archive, the
   checksummed liblp 10.2 metadata has all seven slot-A logical partitions
   populated and every slot-B logical counterpart at zero bytes/zero extents.
   The factory script selects A. Do not test, select or attempt to “repair” B;
   it is intentionally not a bootable copy in this package.
5. Rollback allowed twice over: (a) target patch date ≥ installed patch date;
   (b) every relevant authenticated VBMeta index (header index; chain-descriptor
   location for chained partitions) ≥ the corresponding stored location
   (locations discovered on-device via `fastboot getvar all` + vbmeta
   inspection in unlock and stock restoration testing; unreadable/unproven → stop).
6. `get_unlock_ability` returns `1` immediately before EACH lock command.

## Unlock route binding (do not assume one flow)

Check Settings → About → build/patch first and record which route applies:
(a) code-free toggle (Developer Options → Bootloader Unlocking → wait for
online verification), or (b) legacy code flow (IMEI/serial → code from the
Fairphone page above; code handling stays private). The steps below assume the
code-free route; if the legacy route applies, stop and re-bind before acting.

## Phase 0 — Stock inspection, fastboot only (read-only)

Prereqs: a supported host with official Android platform tools and a USB data cable. No SIM, no ADB, no
settings changes — USB debugging is NOT enabled yet, so no `adb` command can
run here.
Actions: power off → hold Vol Down+Power into fastboot →
`fastboot devices` (identity) → `fastboot oem device-info` →
`fastboot flashing get_unlock_ability` → `fastboot getvar all`
(record, redact serials).
Expected: unlocked:false, critical-unlocked:false; ability may read `0`
before the toggle — normal, not a fault. Destructive effect: none.
Stop: unknown variant or unreadable fastboot → stop, record privately.
Exit: `fastboot reboot` back to Android (required transition into Phase 1).

## Phase 1 — Backup and baseline (non-destructive)

Prereqs: Phase 0 recorded, device rebooted to Android. Enable Developer
Options (7× build number), allow USB debugging, authorize the host; do NOT
toggle OEM unlocking yet.
Actions: `adb shell getprop`, `dumpsys` carrier/IMS set (baseline capture collectors),
photos of defects (private). Destructive: none. Stop: backup target missing →
stop. Exit: original state preserved (stock recovery archiving owns archives).

## Phase 2 — Unlock (destructive, human-led)

Prereqs: backup done, the operator explicitly authorizes both wipes, bound unlock route above,
online verification available.
Sequence (code-free route, per Fairphone support): toggle → wait for verify →
`adb reboot bootloader` → `fastboot flashing unlock` + on-screen approve
(wipe 1) → reboot to fastboot → `fastboot flashing unlock_critical` +
approve (wipe 2). Identity recheck before each flash; re-check
`oem device-info` + `get_unlock_ability` after each step; failure stops the
sequence  — never auto-continue. Recovery exit: completed unlock only;
any `0`/denial → support path, no force flags, no verity disables as repair.

Validated observations: platform-tools 36.0.0-13206524 performed the unlock
steps; the factory package's bundled macOS fastboot 31.0.2-7242960 performed
the restore/relock path. Both unlock commands required physical confirmation
and caused the expected data wipes. Normal unlock preceded critical unlock.

## Phase 3 — Stock restore (destructive, human-led)

Prereqs: stock recovery archiving verified factory package for the EXACT build/model + hashes
(record these recovery-input fields privately:
build_id, source_url and hash_sha256; all must resolve to the accepted archive).
Use Fairphone's manual-install guide for that package only. Destructive: full
wipe. Stop: incompatible model/build hash, unknown rollback index, or ability
`0` where an unlock may be needed → stop. Exit: cold boot to stock + basic
checks.

The official FP6 factory script verifies an embedded checksum list by default,
but its current implementation can continue if no checksum utility is found.
That fallback is not accepted here. Before any flash, independently verify the
complete archive against Fairphone's published SHA-256 and verify the embedded
declared files with a known available checksum tool. Archive inspection alone
does not prove restoration, rollback safety or relock readiness.

Validated EU package facts:

- Archive: `FP6.QREL.16.100.0.20260727183253_WS1M-factory.zip`
- SHA-256: `5e30e5a642f609cd6937825b86e71e416032e17936f0622c27d648aa40b4506d`
- Embedded declarations: 76/76 verified; ZIP CRC passed.
- The unmodified factory script completed all declared flashes/erasures,
  selected slot A, reset rollback indices and booted exact stock successfully.
- Host verification of the signed AVB chain passed with vbmeta Flags `0`.
  Target rollback locations 0–4 are respectively
  `0,1,1785888000,1785888000,1785888000`; locations 5–31 are zero.
- A deliberate B boot attempt is not part of the reproducible procedure. The
  verified factory metadata already proves that B dynamic partitions are empty.
- Android does not expose `avbctl` in this stock build. That is not a failure;
  use host-side pinned `avbtool` evidence plus bootloader Verity state and the
  final locked-green Android properties.

## Phase 4 — Stock relock (destructive, human-led, highest risk)

Prereqs: Phase 3 booted stock, ALL §4.1 checklist items green on this exact
device. Expected trust state here is **green** (Fairphone OEM root) —
**yellow** belongs only to the later custom-key enrollment in Phase 5, never
to stock restoration.
Order per Fairphone support: `fastboot flashing lock_critical` + on-screen
steps → hold Vol-Down into fastboot → `fastboot flashing lock`. Identity
recheck plus `get_unlock_ability` immediately before EACH lock; refuse on
`0`. Confirm green locked state, Flags `0`, digest matches record.
Stop: any unknown → stay unlocked and record the blocker.

### Validated first-boot trap and safe relock path

The default factory script boots Android after flashing. On the validated FP6,
that first unlocked stock boot changed `get_unlock_ability` from `1` to `0`
while Developer options showed a greyed “Bootloader is already unlocked” OEM
control. Do **not** relock in that state, even though the stock boot and hardware
checks pass.

The factory script already declares a `REBOOT_TO_BOOTLOADER` toggle. The tested
recovery was:

1. Keep the original verified script and payloads unchanged. Make a temporary
   same-directory script copy and change only `REBOOT_TO_BOOTLOADER="false"` to
   `REBOOT_TO_BOOTLOADER="true"`; verify a one-replacement diff. Leave the
   integrity, data-wipe and FRP-wipe toggles enabled.
2. Re-run the exact verified factory flash under a new explicit data-loss
   authorization. Do not boot Android afterward.
3. In bootloader, require product FP6, slot A, Verity true, both domains
   unlocked and `get_unlock_ability: 1`.
4. Separately authorize and execute `fastboot flashing lock_critical`; confirm
   physically and return directly to bootloader without booting Android.
5. Require ability `1`, normal unlocked and critical locked.
6. Separately authorize and execute `fastboot flashing lock`; confirm physically
   and wipe. Before Android boot, both domains must report locked.
7. Boot stock. Require exact build/patch, `ro.boot.flash.locked=1`,
   `ro.boot.vbmeta.device_state=locked`,
   `ro.boot.verifiedbootstate=green`, slot A and completed boot. The post-boot
   bootloader state should show ability `0`, both domains locked and the target
   rollback indices above.

This sequence passed a final full power-off cold boot plus display/touch/buttons,
camera/video, microphone/speaker, Wi-Fi/Bluetooth and USB charging/ADB checks.
No anti-rollback bypass, force flag, verity disable or fabricated B-slot content
was used.

## Phase 5 — Later custom enrollment (not in this runbook run)

Requires a test-key candidate build, a validated custom-key relock procedure and an independent
fingerprint reference. Expected state there is yellow (custom root), verified
against the out-of-band fingerprint — not against this stock phase.
Not authorized by this stock-recovery validation.

## Recovery assets and data loss

Assets: verified factory zip + hashes (stock recovery archiving), this checklist version,
private device report. Every flash/unlock/lock wipes. Stop conditions above
are mandatory; a failed command never auto-fires the next destructive step.
