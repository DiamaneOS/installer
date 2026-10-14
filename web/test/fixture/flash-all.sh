#!/bin/sh
# DiamaneOS fixture for the FP6: a clean install from the bootloader.
# This erases all data on the phone.
# It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release.
# This build is signed with public test keys: keep the bootloader unlocked while it is installed.
set -eu
cd "$(dirname "$0")"

fail() { echo "$1" >&2; exit 1; }
command -v fastboot >/dev/null 2>&1 || fail "fastboot is not installed (Android platform-tools)."
value() { fastboot getvar "$1" 2>&1 | sed -n -e "s/^(bootloader) *//" -e "s/^$1: *//p" | head -n 1; }
[ "$(value product)" = "FP6" ] || fail 'This image set is for the FP6: connect that phone in fastboot mode.'
[ "$(value is-userspace)" = "no" ] || fail 'The phone is in fastbootd. Run "fastboot reboot bootloader" and start again.'
[ "$(value unlocked)" = "yes" ] || fail 'The bootloader is locked. Unlock it as Fairphone describes, then start again.'
fastboot oem device-info 2>&1 | grep -q "Device critical unlocked: true" || fail 'The critical partitions are locked, and the firmware is written to them. Run "fastboot flashing unlock_critical" as Fairphone describes (it erases the phone), then start again.'
if command -v sha256sum >/dev/null 2>&1; then sha256sum --quiet -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then shasum -a 256 --quiet -c SHA256SUMS
else fail "Neither sha256sum nor shasum is installed, so the images cannot be checked."; fi

echo "DiamaneOS fixture for the FP6: a clean install from the bootloader."
echo "This erases all data on the phone."
echo "It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release."
echo "This build is signed with public test keys: keep the bootloader unlocked while it is installed."
fastboot flash abl_a abl.elf
fastboot flash abl_b abl.elf
fastboot flash logfs logfs_ufs_8mb.bin
fastboot flash storsec storsec.mbn
fastboot flash modemst1 modemst1.img
fastboot flash modemst2 modemst2.img
fastboot flash boot_a boot.img
fastboot flash vbmeta_a vbmeta.img
fastboot flash super super.img
fastboot flash frp frp.img
fastboot flash metadata metadata.img
fastboot flash misc misc.img
fastboot flash userdata userdata.img
fastboot --set-active=a
fastboot reboot
