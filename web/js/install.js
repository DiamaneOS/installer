// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import * as fastboot from "./fastboot/ffe7e270/fastboot.min.mjs";
import { Flow } from "./flow.js";
import { hashFile, hashFiles } from "./hash.js";
import { customKey, deviceName, lockAllowed, readPackage, supported, writesFirmware } from "./package.js";
import { downloadRelease } from "./release.js";

const Buttons = {
    CONNECT: "connect",
    UNLOCK: "unlock",
    UNLOCK_CRITICAL: "unlock-critical",
    DOWNLOAD: "download",
    INSTALL: "install",
    LOCK_CRITICAL: "lock-critical",
    LOCK: "lock",
};

// After a restart the browser reconnects on its own to a phone it was allowed
// before. Connect again shows after these seconds without it, sooner when the
// phone comes back as another USB device, such as fastbootd, which the browser
// may ask the user to choose.
const ASK_SECONDS = { same: 20, other: 3 };

let wakeLock = null;

const requestWakeLock = async () => {
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        console.log("Wake lock has been set");
        wakeLock.addEventListener("release", async () => {
            console.log("Wake lock has been released");
        });
    } catch (error) {
        // if wake lock request fails - usually system related, such as battery
        throw new Error(`${error.name}, ${error.message}`, { cause: error });
    }
};

const releaseWakeLock = async () => {
    if (wakeLock !== null) {
        wakeLock.release().then(() => {
            wakeLock = null;
        });
    }
};

// reacquires the wake lock should the visibility of the document change and the wake lock is released
document.addEventListener("visibilitychange", async () => {
    if (wakeLock !== null && document.visibilityState === "visible") {
        await requestWakeLock();
    }
});

function log(line) {
    const field = document.getElementById("log");
    field.textContent += `${new Date().toISOString().slice(11, 19)} ${line}\n`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setButtonState({ id, enabled }) {
    const button = document.getElementById(`${id}-button`);
    button.disabled = !enabled;
    return button;
}

let busy = false;
let pkg = null;
let setStatus = () => {};
// The status line of the running action, where "Connect again" appears.
let statusLine = null;
let lastProgress = ["", undefined];
let waitingNote = "";

function showProgress() {
    setStatus([lastProgress[0], waitingNote].filter((text) => text !== "").join(". "), lastProgress[1]);
}

// Passes progress on at most every 100 ms, unless its text changes or it is complete.
function throttled(update) {
    let last = 0;
    let text = null;
    return (...args) => {
        const now = Date.now();
        if (now - last >= 100 || args[0] !== text || args[1] === 1) {
            last = now;
            text = args[0];
            update(...args);
        }
    };
}

const device = new fastboot.FastbootDevice();

// Waits up to seconds for the phone to leave after a command that restarts it.
async function leave(message, seconds = 30) {
    const before = device.device;
    let left = false;
    const onDisconnect = (event) => {
        left ||= event.device === before;
    };
    navigator.usb.addEventListener("disconnect", onDisconnect);
    setStatus(message);
    try {
        const deadline = Date.now() + seconds * 1000;
        while (!left && device.isConnected && Date.now() < deadline) {
            await sleep(250);
        }
    } finally {
        navigator.usb.removeEventListener("disconnect", onDisconnect);
    }
    return { left, gone: left || !device.isConnected };
}

// Waits for the phone to leave after a restart, then for it to come back.
// Resolves to false if it did not leave in time and to null if it did not come
// back in time. Connect again appears only when the browser did not reconnect
// on its own.
async function reconnect(message, seconds = 30, back = Infinity, choose = false) {
    const button = document.getElementById("reconnect-button");
    const before = device.device;
    const { left, gone } = await leave(message, seconds);
    if (!gone) {
        return false;
    }
    const ask = Date.now() + (choose ? ASK_SECONDS.other : ASK_SECONDS.same) * 1000;
    const deadline = Date.now() + back * 1000;
    let poll;
    try {
        const returned = await new Promise((resolve) => {
            poll = setInterval(() => {
                if (device.isConnected && (left || device.device !== before)) {
                    resolve(true);
                } else if (Date.now() > deadline) {
                    resolve(false);
                } else if (button.hidden && Date.now() > ask) {
                    setStatus(`${message} ${choose
                        ? "Once it shows fastbootd, press Connect again and choose the phone."
                        : "If it is back in Fastboot Mode and the installer does not continue, press Connect again."}`);
                    statusLine?.after(button);
                    button.hidden = false;
                }
            }, 250);
            button.onclick = async () => {
                try {
                    await device.connect();
                } catch (error) {
                    log(`Connecting failed: ${error.message}`);
                }
            };
        });
        if (!returned) {
            return null;
        }
    } finally {
        clearInterval(poll);
        button.hidden = true;
        button.onclick = null;
    }
    log("Connected again");
    return true;
}

const flow = new Flow(device, {
    async connect() {
        if (!device.isConnected) {
            setStatus("Connecting to the phone...");
            await device.connect();
        }
    },
    reconnect,
    async leave(message, seconds) {
        return (await leave(message, seconds)).gone;
    },
    progress(text, fraction) {
        lastProgress = [text, fraction];
        showProgress();
    },
    waiting(seconds) {
        const note = seconds === null ? "" : `Waiting for the phone: ${seconds} s`;
        if (note !== waitingNote) {
            waitingNote = note;
            showProgress();
        }
    },
    log,
});

function describe(state) {
    const lines = [`${deviceName(state.product) ?? "Unknown phone"} in ${state.userspace === "yes" ? "fastbootd" : "the bootloader"}.`];
    if (state.userspace !== "yes") {
        lines.push(`Bootloader ${state.unlocked === "yes" ? "unlocked" : "locked"}.`);
        if (state.critical !== null) {
            lines.push(`Critical partitions ${state.critical ? "unlocked" : "locked"}.`);
        }
        if (state.ability !== null) {
            lines.push(`Unlocking ${state.ability === 1 ? "allowed" : "not allowed"}.`);
        }
    }
    return lines.join(" ");
}

function showState(state) {
    document.getElementById("connect-status").textContent = describe(state);
}

async function connect() {
    if (!device.isConnected) {
        setStatus("Connecting to the phone...");
        await device.connect();
    }
    return describe(await flow.state());
}

async function unlockStep(critical) {
    const state = await flow.unlock(critical);
    if (state === null) {
        return "The phone did not return to Fastboot Mode. If Android started, turn the phone off and start it in "
            + "Fastboot Mode. Then press Connect.";
    }
    showState(state);
    return describe(state);
}

function installed(state) {
    return state === null
        ? "Installed. The phone restarts into DiamaneOS."
        : "Installed. The phone waits in Fastboot Mode. Do not start Android: lock it below first.";
}

async function install() {
    if (pkg === null) {
        throw new Error("Get the image set first.");
    }
    await requestWakeLock();
    try {
        const state = await flow.install(pkg);
        if (state !== null) {
            showState(state);
        }
        return installed(state);
    } finally {
        await releaseWakeLock();
    }
}

async function lockCritical() {
    await requestWakeLock();
    try {
        showState(await flow.lockCritical(pkg));
    } finally {
        await releaseWakeLock();
    }
    return "The critical partitions are locked and the phone is back in Fastboot Mode. Do not start Android. "
        + "Lock the bootloader next.";
}

async function lock() {
    await requestWakeLock();
    try {
        await flow.lock(pkg);
    } finally {
        await releaseWakeLock();
    }
    return "The phone erases all data and starts DiamaneOS. Each start shows a yellow warning screen with the ID "
        + "of the key the OS is signed with. This is expected. An orange screen means the bootloader is still "
        + "unlocked.";
}

// In a new tab, so that the page of a running install stays open.
function recoveryLink(statusField) {
    const link = document.createElement("a");
    link.href = "recovery.html";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "What to do now";
    statusField.append(" ", link);
}

function addButtonHook(id, callback, { recovery = false } = {}) {
    let statusContainer = document.getElementById(`${id}-status-container`);
    let statusField = document.getElementById(`${id}-status`);
    let progressBar = document.getElementById(`${id}-progress`);

    let statusCallback = (status, progress) => {
        if (statusContainer !== null) {
            statusContainer.hidden = false;
        }

        statusField.className = "";
        statusField.textContent = status;

        if (progressBar !== null) {
            progressBar.hidden = progress === undefined;
            if (progress !== undefined) {
                progressBar.value = progress;
            }
        }
    };

    let button = setButtonState({ id, enabled: true });
    button.onclick = async () => {
        busy = true;
        setStatus = statusCallback;
        statusLine = statusContainer ?? statusField.parentElement;
        lastProgress = ["", undefined];
        waitingNote = "";
        refresh();
        try {
            let finalStatus = await callback(statusCallback);
            if (finalStatus !== undefined) {
                statusCallback(finalStatus);
            }
        } catch (error) {
            let errorMessage;
            if (typeof(error) === "object" && error.message != null && error.message !== "") {
                errorMessage = error.message;
            } else {
                // sometimes non-error objects are thrown
                errorMessage = String(error);
            }
            log(`Error: ${errorMessage}`);
            statusCallback(`Error: ${errorMessage}`);
            statusField.className = "error-text";
            if (recovery) {
                recoveryLink(statusField);
            }
            // Rethrow the error so it shows up in the console
            throw error;
        } finally {
            busy = false;
            refresh();
        }
    };
}

function refresh() {
    const usb = "usb" in navigator;
    const record = pkg?.record;
    const known = flow.known();
    const confirmed = record !== undefined
        && (!writesFirmware(record) || document.getElementById("firmware-confirm").checked);
    const lockStep = record !== undefined && lockAllowed(record) ? flow.lockStep(pkg) : null;
    // Connect is greyed out while the phone is connected. A restart disconnects it and enables it again.
    setButtonState({ id: Buttons.CONNECT, enabled: usb && !busy && !device.isConnected });
    // A step is greyed out once the phone reports it done, and unlocking while a lock is due.
    setButtonState({ id: Buttons.UNLOCK, enabled: usb && !busy && lockStep === null && known?.unlocked !== "yes" });
    setButtonState({ id: Buttons.UNLOCK_CRITICAL, enabled: usb && !busy && lockStep === null
        && known?.critical !== true && known?.unlocked !== "no" });
    setButtonState({ id: Buttons.DOWNLOAD, enabled: usb && !busy });
    setButtonState({ id: Buttons.INSTALL, enabled: usb && !busy && confirmed });
    setButtonState({ id: Buttons.LOCK_CRITICAL, enabled: usb && !busy && lockStep === "critical" });
    setButtonState({ id: Buttons.LOCK, enabled: usb && !busy && lockStep === "bootloader" });
    for (const id of ["folder-button", "files-button"]) {
        document.getElementById(id).disabled = !usb || busy;
    }
}

function showPackage(record) {
    const firmware = writesFirmware(record) ? record.firmware.release : null;
    document.getElementById("package-summary").textContent = [
        `DiamaneOS ${record.build_id} for the ${deviceName(record.product)}.`,
        firmware ? `It writes the device maker's ${firmware} firmware.` : "",
        record.notice ?? "",
    ].join(" ").trim();
    document.getElementById("firmware-release").textContent = firmware ?? "the one in the image set";
    document.getElementById("firmware-check").hidden = firmware === null;
    let notice = record.notice ?? "This image set must stay on an unlocked phone.";
    if (lockAllowed(record)) {
        notice = "This image set installs its signing key, and the bootloader can be locked straight after the "
            + "install.";
    } else if (record.never_lock === false && customKey(record) === null) {
        notice = "This image set installs no signing key, so the installer cannot lock it.";
    }
    document.getElementById("lock-notice").textContent = notice;
}

// Checks the files of an image set, from a folder or a release, and keeps it for the install.
async function usePackage(files, report) {
    pkg = null;
    document.getElementById("package-summary").textContent = "";
    const result = await readPackage(files);
    report(`Checking ${result.needed.length} files against SHA256SUMS...`, 0);
    const digests = await hashFiles(result.needed.map((name) => [name, files.get(name)]),
        (fraction) => report(`Checking ${result.needed.length} files against SHA256SUMS...`, fraction));
    const wrong = result.needed.filter((name) => digests.get(name) !== result.sums.get(name));
    if (wrong.length > 0) {
        throw new Error(`These files do not match SHA256SUMS: ${wrong.join(", ")}. Get the image set again.`);
    }
    pkg = { ...result, files };
    showPackage(result.record);
    log(`Image set ${result.record.build_id} checked`);
    return `All ${result.needed.length} files the install uses match SHA256SUMS.`;
}

async function download(report) {
    await requestWakeLock();
    try {
        if (!device.isConnected) {
            report("Connecting to the phone...");
            await device.connect();
        }
        const product = (flow.known() ?? await flow.state()).product;
        if (!supported(product)) {
            throw new Error(`The phone reports ${product ?? "no product"}, which this installer does not support.`);
        }
        const digest = (blob, algorithm, onProgress) => hashFile(blob, algorithm, onProgress);
        const { version, files } = await downloadRelease(product, digest, throttled(report));
        log(`Release ${version} downloaded and its signature checked`);
        return await usePackage(files, report);
    } finally {
        await releaseWakeLock();
    }
}

async function choosePackage(list) {
    const status = document.getElementById("package-status");
    const progressBar = document.getElementById("package-progress");
    const files = new Map();
    for (const file of list) {
        // Only the files at the top of a chosen folder.
        if (file.webkitRelativePath.split("/").length <= 2) {
            files.set(file.name, file);
        }
    }
    busy = true;
    refresh();
    status.className = "";
    const report = (text, fraction) => {
        status.textContent = text;
        progressBar.hidden = fraction === undefined;
        progressBar.value = fraction ?? 0;
    };
    try {
        report(await usePackage(files, report));
    } catch (error) {
        report(`Error: ${error.message}`);
        status.className = "error-text";
        log(`Error: ${error.message}`);
    } finally {
        busy = false;
        refresh();
    }
}

function logText() {
    return document.getElementById("log").textContent;
}

function setupLog() {
    const status = document.getElementById("log-status");
    document.getElementById("log-copy-button").onclick = async () => {
        try {
            await navigator.clipboard.writeText(logText());
            status.textContent = "Copied.";
        } catch (error) {
            status.textContent = `Copying failed: ${error.message}`;
        }
    };
    document.getElementById("log-save-button").onclick = () => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([logText()], { type: "text/plain" }));
        link.download = `diamaneos-installer-log-${new Date().toISOString().slice(0, 10)}.txt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        status.textContent = "";
    };
}

// When the browser reconnects to a phone on its own and nothing runs, the
// buttons follow the phone's state.
async function readState() {
    for (let i = 0; i < 20 && !device.isConnected; i++) {
        await sleep(250);
    }
    if (busy || !device.isConnected || flow.known() !== null) {
        return;
    }
    busy = true;
    refresh();
    try {
        showState(await flow.state());
    } catch (error) {
        log(`Reading the phone's state failed: ${error.message}`);
    } finally {
        busy = false;
        refresh();
    }
}

// This doesn't really hurt, and because this page is exclusively for web install,
// we can tolerate extra logging in the console in case something goes wrong.
fastboot.setDebugLevel(1);

setupLog();

if ("usb" in navigator) {
    addButtonHook(Buttons.CONNECT, connect);
    addButtonHook(Buttons.UNLOCK, () => unlockStep(false));
    addButtonHook(Buttons.UNLOCK_CRITICAL, () => unlockStep(true), { recovery: true });
    addButtonHook(Buttons.DOWNLOAD, download);
    addButtonHook(Buttons.INSTALL, install, { recovery: true });
    addButtonHook(Buttons.LOCK_CRITICAL, lockCritical, { recovery: true });
    addButtonHook(Buttons.LOCK, lock, { recovery: true });
    navigator.usb.addEventListener("connect", () => {
        refresh();
        if (!busy) {
            readState();
        }
    });
    // The lock is offered only while the phone stays connected after the install.
    navigator.usb.addEventListener("disconnect", (event) => {
        document.getElementById("connect-status").textContent = "Not connected.";
        const step = flow.lost(event.device);
        if (step !== null) {
            document.getElementById(step === "critical" ? "lock-critical-status" : "lock-status").textContent =
                "The phone restarted, so it cannot be locked now. Install again, then lock straight after.";
        }
        refresh();
    });
    for (const id of ["folder", "files"]) {
        const input = document.getElementById(`${id}-input`);
        input.addEventListener("change", () => choosePackage(input.files));
        document.getElementById(`${id}-button`).onclick = () => input.click();
    }
    document.getElementById("firmware-confirm").addEventListener("change", refresh);
    refresh();
} else {
    for (const id of Object.values(Buttons)) {
        const statusContainer = document.getElementById(`${id}-status-container`);
        const statusField = document.getElementById(`${id}-status`);
        if (statusContainer !== null) {
            statusContainer.hidden = false;
        }
        statusField.className = "error-text";
        statusField.textContent = "This browser has no WebUSB. Use a Chromium-based browser such as Chrome or Edge.";
    }
}

// This will create an alert box to stop the user from leaving the page during actions
window.addEventListener("beforeunload", event => {
    if (busy) {
        event.preventDefault();
        event.returnValue = "";
    }
});

// @license-end
