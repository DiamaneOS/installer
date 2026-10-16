@echo off
rem DiamaneOS fixture for the FP6: a clean install from the bootloader.
rem This erases all data on the phone.
rem It writes Fairphone's FP6.QREL.16.111.0 firmware first. Do not run it on a phone that already runs a newer Fairphone release.
rem The phone restarts into fastbootd for the system partitions, then back into the bootloader.
rem This build is signed with public test keys: keep the bootloader unlocked while it is installed.
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
echo The phone restarts into fastbootd for the system partitions, then back into the bootloader.
echo This build is signed with public test keys: keep the bootloader unlocked while it is installed.
fastboot flash abl_a abl.elf || exit /b 1
fastboot flash abl_b abl.elf || exit /b 1
fastboot flash logfs logfs_ufs_8mb.bin || exit /b 1
fastboot flash storsec storsec.mbn || exit /b 1
fastboot flash modemst1 modemst1.img || exit /b 1
fastboot flash modemst2 modemst2.img || exit /b 1
fastboot flash boot_a boot.img || exit /b 1
fastboot flash vbmeta_a vbmeta.img || exit /b 1
fastboot reboot fastboot || exit /b 1
call :waitfor yes "fastbootd" || exit /b 1
fastboot wipe-super super_empty.img || exit /b 1
fastboot flash system_a system.img || exit /b 1
fastboot flash vendor_a vendor.img || exit /b 1
fastboot reboot-bootloader || exit /b 1
call :waitfor no "the bootloader" || exit /b 1
fastboot flash frp frp.img || exit /b 1
fastboot flash metadata metadata.img || exit /b 1
fastboot flash misc misc.img || exit /b 1
fastboot flash userdata userdata.img || exit /b 1
fastboot --set-active=a || exit /b 1
fastboot reboot || exit /b 1
exit /b 0

:waitfor
echo Waiting for %~2.
set n=0
:waitfor_poll
fastboot getvar is-userspace 2>&1 | findstr /r /c:"is-userspace: *%1" >nul && exit /b 0
set /a n+=1
if %n% geq 90 (echo The phone did not reach %~2. Hold Power and Volume down until it restarts into the bootloader, then run this script again. & exit /b 1)
ping -n 3 127.0.0.1 >nul
goto waitfor_poll
