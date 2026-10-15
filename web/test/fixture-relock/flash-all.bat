@echo off
rem DiamaneOS fixture for the FP6: a clean install from the bootloader.
rem This erases all data on the phone.
rem It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release.
rem It installs the signing key and stops in the bootloader. To lock, run fastboot flashing get_unlock_ability (it must report 1), then fastboot flashing lock, and confirm on the phone. Do not start Android before the lock.
setlocal
cd /d "%~dp0"

where fastboot >nul 2>&1 || (echo fastboot is not installed ^(Android platform-tools^). & exit /b 1)
fastboot getvar product 2>&1 | findstr /r /c:"product: *FP6" >nul || (echo This image set is for the FP6: connect that phone in fastboot mode. & exit /b 1)
fastboot getvar is-userspace 2>&1 | findstr /r /c:"is-userspace: *no" >nul || (echo The phone is in fastbootd. Run 'fastboot reboot bootloader' and start again. & exit /b 1)
fastboot getvar unlocked 2>&1 | findstr /r /c:"unlocked: *yes" >nul || (echo The bootloader is locked. Unlock it as Fairphone describes, then start again. & exit /b 1)
fastboot oem device-info 2>&1 | findstr /c:"Device critical unlocked: true" >nul || (echo The critical partitions are locked, and the firmware is written to them. Run 'fastboot flashing unlock_critical' as Fairphone describes ^(it erases the phone^), then start again. & exit /b 1)

echo DiamaneOS fixture for the FP6: a clean install from the bootloader.
echo This erases all data on the phone.
echo It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release.
echo It installs the signing key and stops in the bootloader. To lock, run fastboot flashing get_unlock_ability ^(it must report 1^), then fastboot flashing lock, and confirm on the phone. Do not start Android before the lock.
fastboot flash abl_a abl.elf || exit /b 1
fastboot flash abl_b abl.elf || exit /b 1
fastboot flash logfs logfs_ufs_8mb.bin || exit /b 1
fastboot flash storsec storsec.mbn || exit /b 1
fastboot flash modemst1 modemst1.img || exit /b 1
fastboot flash modemst2 modemst2.img || exit /b 1
fastboot flash boot_a boot.img || exit /b 1
fastboot flash vbmeta_a vbmeta.img || exit /b 1
fastboot flash super super.img || exit /b 1
fastboot flash frp frp.img || exit /b 1
fastboot flash metadata metadata.img || exit /b 1
fastboot flash misc misc.img || exit /b 1
fastboot flash userdata userdata.img || exit /b 1
fastboot flash avb_custom_key avb_pkmd.bin || exit /b 1
fastboot --set-active=a || exit /b 1
fastboot reboot-bootloader || exit /b 1
echo To lock, run fastboot flashing get_unlock_ability ^(it must report 1^), then fastboot flashing lock, and confirm on the phone. Do not start Android before the lock.
