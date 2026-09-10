# FP6 Arrival and Recovery Preflight — DRAFT, prepared not tested

Status: prepared 2026-09-10, not validated on a physical device. No operational proof claimed.
No placeholder below may be executed as a universal command; hardware-dependent
sequences stay blocked until stock device inspection / stock recovery archiving / unlock and stock restoration testing validates them on the exact device.

Sources (retrieved 2026-09-10):
- Fairphone unlock/lock guide (2026-07-09):
  <https://support.fairphone.com/hc/en-us/articles/10492476238865-How-to-unlock-or-lock-your-Fairphone-s-bootloader>
- Fairphone bootloader-code page (toggle + online verification; ability `0` →
  support case): <https://www.fairphone.com/bootloader-unlocking-code-for-fairphone>
- LineageOS FP6 install wiki (Vol Down+Power, partition set):
  <https://wiki.lineageos.org/devices/FP6/install/>
- source research stock ledger (factory FP6.QREL.16.95.0 / OTA 16.82.0 proposal).

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
  (b) AVB index rule: each vbmeta descriptor carries a rollback_index for its
  partition; the bootloader compares it against the matching stored index in
  tamper-evident storage and refuses older values. Patch dates and stored
  indices are different kinds of values — both must independently allow the
  target; an unreadable index is a stop, never an assumption.
  Source: AOSP AVB README (Rollback Protection).
- `unlock` then `unlock_critical`, each wipes; `unlock_critical` fails with
  `Flashing Unlock is not allowed` unless the first unlock + on-screen approval
  completed and ability is `1`.

## §4.1 preflight checklist (all must be green before any relock)

1. Exact FP6 variant and firmware build recorded (About phone).
2. Complete compatible factory images + SHA256 verified (stock recovery archiving package).
3. AVB chain reviewed: vbmeta Flags `0` expected for verification on;
   Flags `3` boots unlocked but fails locked.
4. Slot states known (`getvar all`; no half-flashed slot).
5. Rollback allowed twice over: (a) target patch date ≥ installed patch date;
   (b) every target image rollback_index ≥ the corresponding stored index
   (locations discovered on-device via `fastboot getvar all` + vbmeta
   descriptors in unlock and stock restoration testing; unreadable/unproven → stop).
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

Prereqs: backup done, owner accepts double wipe, bound unlock route above,
online verification available.
Sequence (code-free route, per Fairphone support): toggle → wait for verify →
`adb reboot bootloader` → `fastboot flashing unlock` + on-screen approve
(wipe 1) → reboot to fastboot → `fastboot flashing unlock_critical` +
approve (wipe 2). Identity recheck before each flash; re-check
`oem device-info` + `get_unlock_ability` after each step; failure stops the
sequence  — never auto-continue. Recovery exit: completed unlock only;
any `0`/denial → support path, no force flags, no verity disables as repair.

## Phase 3 — Stock restore (destructive, human-led)

Prereqs: stock recovery archiving verified factory package for the EXACT build/model + hashes
(record these recovery-input fields privately:
build_id, source_url, hash_sha256, all unresolved until download).
Use Fairphone's manual-install guide for that package only. Destructive: full
wipe. Stop: incompatible model/build hash, unknown rollback index, or ability
`0` where an unlock may be needed → stop. Exit: cold boot to stock + basic
checks (unlock and stock restoration testing owns the test).

## Phase 4 — Stock relock (destructive, human-led, highest risk)

Prereqs: Phase 3 booted stock, ALL §4.1 checklist items green on this exact
device. Expected trust state here is **green** (Fairphone OEM root) —
**yellow** belongs only to the later custom-key enrollment in Phase 5, never
to stock restoration.
Order per Fairphone support: `fastboot flashing lock_critical` + on-screen
steps → hold Vol-Down into fastboot → `fastboot flashing lock`. Identity
recheck plus `get_unlock_ability` immediately before EACH lock; refuse on
`0`. Confirm green locked state, Flags `0`, digest matches record.
Stop: any unknown  → stay unlocked, record blocker. No universal lock
command is given here.

## Phase 5 — Later custom enrollment (not in this runbook run)

Requires a test-key candidate build, a validated custom-key relock procedure and an independent
fingerprint reference. Expected state there is yellow (custom root), verified
against the out-of-band fingerprint — not against this stock phase.
Not authorized by this draft.

## Recovery assets and data loss

Assets: verified factory zip + hashes (stock recovery archiving), this checklist version,
private device report. Every flash/unlock/lock wipes. Stop conditions above
are mandatory; a failed command never auto-fires the next destructive step.
