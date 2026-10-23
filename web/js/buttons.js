// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// A step that is done is greyed out and says so. It is offered again when it
// is needed again.

// Whether a step done on a USB device still holds: for the same image set and
// on the same device. While a step runs, its own restarts do not end it.
export function stillDone(record, pkg, usb, busy) {
    return record != null && record.pkg === pkg && (busy || record.usb === usb);
}

// Whether the downloaded release is still the one to install: it is the set in
// use, the connected phone (null when none) is its product, and the channel
// last named it (latest, undefined until checked).
export function releaseCurrent(release, pkg, product, latest) {
    return release != null && release.pkg === pkg && (product == null || product === release.product)
        && (latest === undefined || latest === release.version);
}

// s: usb, busy, connected, known (the phone's state on this connection or
// null), confirmed (an image set is checked and its firmware confirmed),
// lockStep ("critical", "bootloader" or null), and what is done: downloaded
// (the release version or null), installed and criticalLocked. While a lock is
// due, the install is done and no other set can be got.
export function buttonStates(s) {
    const can = s.usb && !s.busy;
    const unlocked = s.known?.unlocked === "yes";
    const critical = s.known?.critical === true;
    const installed = s.installed || s.lockStep !== null;
    const criticalLocked = s.criticalLocked || s.lockStep === "bootloader";
    return {
        "connect": { enabled: can && !s.connected, label: s.connected ? "Connected" : "Connect" },
        "unlock": {
            enabled: can && s.lockStep === null && !unlocked,
            label: unlocked ? "Bootloader unlocked" : "Unlock bootloader",
        },
        "unlock-critical": {
            enabled: can && s.lockStep === null && !critical && s.known?.unlocked !== "no",
            label: critical ? "Critical partitions unlocked" : "Unlock critical partitions",
        },
        "download": {
            enabled: can && s.lockStep === null && s.downloaded === null,
            label: s.downloaded === null ? "Download release" : `Downloaded ${s.downloaded}`,
        },
        "install": { enabled: can && s.confirmed && !installed, label: installed ? "Installed" : "Install" },
        "lock-critical": {
            enabled: can && s.lockStep === "critical",
            label: criticalLocked ? "Critical partitions locked" : "Lock critical partitions",
        },
        "lock": { enabled: can && s.lockStep === "bootloader", label: "Lock bootloader" },
    };
}

// @license-end
