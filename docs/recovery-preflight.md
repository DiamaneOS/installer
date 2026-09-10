# FP6 Arrival and Recovery Preflight — DRAFT, prepared not tested

Status: prepared 2026-09-10, not validated on a physical device. No operational proof claimed.
No placeholder below may be executed as a universal command; hardware-dependent
sequences stay blocked until stock device inspection / stock recovery archiving / unlock and stock restoration testing validates them on the exact device.
Sources: Fairphone support unlock/lock article (2026-07-09), Fairphone
bootloader-code page (toggle + online verification; `get_unlock_ability: 0` →
support case), LineageOS FP6 install wiki (Vol Down+Power, partition set),
source research stock ledger (factory FP6.QREL.16.95.0 / OTA 16.82.0 proposal).

## Brick rules (read first)

- Before EVERY `lock`/`lock_critical`: `fastboot flashing get_unlock_ability`
  must return `1`. On `0`, stop — do not lock, do not force, contact support
  path. Unlock-ability alone never authorizes relock.
- Relock needs the complete documented set: exact variant + firmware, full
  compatible images/slots, AVB chain with vbmeta Flags `0` (Flags `3` boots
  unlocked, fails locked after the yellow screen), rollback indices, and the
  `lock_critical`-then-`lock` order with Vol-Down reboot between.
- Anti-rollback: never flash an image with an older security patch than the
  device's stored rollback index and relock — fatal when locked, ignored when
  unlocked. Patch level, not Android version, controls it.
- `unlock` then `unlock_critical`, each wipes; `unlock_critical` fails with
  `Flashing Unlock is not allowed` unless the first unlock + on-screen approval
  completed and ability is `1`.

## Phase 0 — Stock inspection (read-only)

Prereqs: a supported host with official Android platform tools and a USB data cable, no SIM needed.
State: locked stock, OEM unlocking untouched.
Actions (illustrative, source: Fairphone support + Lineage wiki):
`adb devices` → authorize → `adb reboot bootloader`;
`fastboot oem device-info`, `fastboot flashing get_unlock_ability`,
`fastboot getvar all` (record, redact serials).
Expected: unlocked:false, critical-unlocked:false, ability may read `0` before
toggle — normal, not a fault. Destructive effect: none. Stop: unknown variant
or unreadable fastboot → stop, record privately. Exit: unplug.

## Phase 1 — Backup and baseline (non-destructive)

Prereqs: Phase 0 recorded. Enable Developer Options (7× build number), allow
USB debugging; do NOT toggle OEM unlocking yet.
Actions: `adb shell getprop`, `dumpsys` carrier/IMS set (baseline capture collectors),
photos of defects (private). Destructive: none. Stop: backup target missing →
stop. Exit: original state preserved (stock recovery archiving owns archives).

## Phase 2 — Unlock (destructive, human-led)

Prereqs: backup done, owner accepts double wipe, online verification available
(Settings → Developer Options → Bootloader Unlocking toggle, wait for verify).
Sequence per Fairphone support: toggle → `adb reboot bootloader` →
`fastboot flashing unlock` + on-screen approve (wipe 1) → reboot to fastboot →
`fastboot flashing unlock_critical` + approve (wipe 2). Re-check
`oem device-info` + `get_unlock_ability` after each step; failure stops the
sequence  — never auto-continue. Recovery exit: completed unlock only;
any `0`/denial → support path, no force flags, no verity disables as repair.

## Phase 3 — Stock restore (destructive, human-led)

Prereqs: stock recovery archiving verified factory package for the EXACT build/model + hashes.
Use Fairphone's manual-install guide for that package only. Destructive: full
wipe. Stop: incompatible model/build hash, unknown rollback index, or ability
`0` where an unlock may be needed → stop. Exit: cold boot to stock + basic
checks (unlock and stock restoration testing owns the test).

## Phase 4 — Stock relock (destructive, human-led, highest risk)

Prereqs: Phase 3 booted stock, ALL §4.1 checks green on this exact device.
Order per Fairphone support: `fastboot flashing lock_critical` + on-screen
steps → hold Vol-Down into fastboot → `fastboot flashing lock`. Check
`get_unlock_ability` immediately before EACH lock; refuse on `0`. Confirm
yellow/verified state, Flags `0`, digest matches record. Stop: any unknown
 → stay unlocked, record blocker. No universal lock command is given here.

## Phase 5 — Later custom enrollment (not in this runbook run)

Requires a test-key candidate build, a validated custom-key relock procedure and an independent
fingerprint reference. Not authorized by this draft.

## Recovery assets and data loss

Assets: verified factory zip + hashes (stock recovery archiving), this checklist version,
private device report. Every flash/unlock/lock wipes. Stop conditions above
are mandatory; a failed command never auto-fires the next destructive step.
