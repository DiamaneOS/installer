#!/bin/sh
# DiamaneOS fixture for the Fairphone 6: a clean install from the bootloader.
# This erases all data on the phone.
# It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release.
# The phone restarts into fastbootd for the system partitions, then back into the bootloader.
# This build is signed with public test keys: keep the bootloader unlocked while it is installed.
# To lock it anyway, run the script with the argument lock. It warns and asks first.
set -eu
cd "$(dirname "$0")"

fail() { echo "$1" >&2; exit 1; }
command -v fastboot >/dev/null 2>&1 || fail "fastboot is not installed (Android platform-tools)."
value() { reply=$(fastboot getvar "$1" 2>&1) || true; printf "%s\n" "$reply" | sed -n -e "s/^(bootloader) *//" -e "s/^$1: *//p" | head -n 1; }
checkslot() { reply=$(fastboot getvar current-slot 2>&1) || fail "Cannot verify the selected slot."; observed=$(printf "%s\n" "$reply" | sed -n -e "s/^(bootloader) *//" -e "s/^current-slot: *//p" | tr -d "\r"); [ "$observed" = "$1" ] || fail "The active slot does not match this image set."; }
waitfor() { echo "Waiting for $2."; n=0; until [ "$(value is-userspace)" = "$1" ]; do n=$((n + 1)); [ $n -lt 90 ] || fail "The phone did not reach $2. Hold Power and Volume down until it restarts into the bootloader, then run this script again."; sleep 2; done; }
[ "$(value product)" = "FP6" ] || fail 'This image set is for the Fairphone 6 (FP6). Connect that phone in fastboot mode.'
[ "$(value is-userspace)" = "no" ] || fail 'The phone is in fastbootd. Run "fastboot reboot bootloader" and start again.'
[ "$(value unlocked)" = "yes" ] || fail 'The bootloader is locked. Unlock it as https://diamaneos.de/install/cli/ describes, then start again.'
info=$(fastboot oem device-info 2>&1) || true
printf "%s\n" "$info" | grep -q "Device critical unlocked: true" || fail 'The critical partitions are locked, and the firmware is written to them. Run "fastboot flashing unlock_critical" as https://diamaneos.de/install/cli/ describes (it erases the phone), then start again.'
case "$*" in ''|lock) ;; *) fail "Run the script without arguments, or with lock to lock the bootloader after the install." ;; esac
lock=no
if [ "${1:-}" = lock ]; then
echo "WARNING: this build is signed with the public test keys, which anyone can download. A phone locked with it accepts any image or update signed with them, so the lock does not protect it. Lock it only for a test. Then unlock it again. To keep the phone locked, install a release or a build signed with your own keys."
printf '%s' 'Type yes to install the public test key, so that you can lock the bootloader after the install: '
read -r answer || answer=
[ "$answer" = yes ] || fail "Not confirmed. Nothing was written."
lock=yes
fi
if command -v sha256sum >/dev/null 2>&1; then sha256sum --quiet -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then shasum -a 256 --quiet -c SHA256SUMS
else fail "Neither sha256sum nor shasum is installed, so the images cannot be checked."; fi

echo "DiamaneOS fixture for the Fairphone 6: a clean install from the bootloader."
echo "This erases all data on the phone."
echo "It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release."
echo "The phone restarts into fastbootd for the system partitions, then back into the bootloader."
echo "This build is signed with public test keys: keep the bootloader unlocked while it is installed."
echo "To lock it anyway, run the script with the argument lock. It warns and asks first."
fastboot flash abl_a abl.elf
fastboot flash abl_b abl.elf
fastboot flash logfs logfs_ufs_8mb.bin
fastboot flash storsec storsec.mbn
fastboot flash modemst1 modemst1.img
fastboot flash modemst2 modemst2.img
status=$(value snapshot-update-status)
if [ -n "$status" ] && [ "$status" != none ]; then
fastboot snapshot-update cancel
fi
fastboot flash boot_a boot.img
fastboot flash vbmeta_a vbmeta.img
fastboot flash misc misc.img
fastboot --set-active=a
checkslot a
fastboot reboot fastboot
waitfor yes "fastbootd"
fastboot wipe-super super_empty.img
fastboot flash system_a system.img
fastboot flash vendor_a vendor.img
fastboot reboot-bootloader
waitfor no "the bootloader"
fastboot flash frp frp.img
fastboot flash metadata metadata.img
fastboot flash misc misc.img
fastboot flash userdata userdata.img
if [ "$lock" = yes ]; then
fastboot flash avb_custom_key avb_pkmd.bin
fastboot --set-active=a
checkslot a
fastboot reboot-bootloader
echo "WARNING: this build is signed with the public test keys, which anyone can download. A phone locked with it accepts any image or update signed with them, so the lock does not protect it. Lock it only for a test. Then unlock it again. To keep the phone locked, install a release or a build signed with your own keys."
echo "If the phone ran a locked build before, first run fastboot oem reset-rollback, or the test build will not start once locked. Keep OEM unlocking on in the setup, so that you can unlock the phone again."
echo "To lock, first check that fastboot flashing get_unlock_ability reports 1, or stop there. Then run fastboot flashing lock_critical and confirm on the phone. It wipes the phone and restarts. Hold Volume down while it restarts, so that it comes back to the bootloader: Android must not start before the second lock. Then fastboot flashing get_unlock_ability must report 1 again, or stop there. Then run fastboot flashing lock and confirm on the phone."
else
fastboot --set-active=a
checkslot a
fastboot reboot
fi
