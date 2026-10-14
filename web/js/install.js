// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import * as fastboot from "./fastboot/ffe7e270/fastboot.min.mjs";
import { Flow, SuperStopped } from "./flow.js";
import { hashFiles } from "./hash.js";
import { lockAllowed, readPackage, writesFirmware } from "./package.js";

const Buttons = {
    CONNECT: "connect",
    UNLOCK: "unlock",
    UNLOCK_CRITICAL: "unlock-critical",
    INSTALL: "install",
    FALLBACK: "fallback",
    LOCK: "lock",
};

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
let lastProgress = ["", undefined];
let waitingNote = "";

function showProgress() {
    setStatus(lastProgress[0] + waitingNote, lastProgress[1]);
}

const device = new fastboot.FastbootDevice();

// Waits for the phone to leave after a restart, then for it to come back. A
// phone in fastbootd is a new USB device to the browser, so it may need a click.
async function reconnect(message) {
    const button = document.getElementById("reconnect-button");
    const left = (async () => {
        const deadline = Date.now() + 30000;
        while (device.isConnected && Date.now() < deadline) {
            await sleep(250);
        }
    })();
    await Promise.race([device.waitForDisconnect(), left]);
    setStatus(`${message} When it shows its screen, press Connect again if the installer does not continue.`);
    button.hidden = false;
    try {
        await new Promise((resolve) => {
            const poll = setInterval(() => {
                if (device.isConnected) {
                    clearInterval(poll);
                    resolve();
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
    } finally {
        button.hidden = true;
        button.onclick = null;
    }
    log("Connected again");
}

const flow = new Flow(device, {
    async connect() {
        if (!device.isConnected) {
            setStatus("Connecting to the phone...");
            await device.connect();
        }
    },
    reconnect,
    progress(text, fraction) {
        lastProgress = [text, fraction];
        showProgress();
    },
    waiting(seconds) {
        const note = seconds === null ? "" : `. Waiting for the phone: ${seconds} s`;
        if (note !== waitingNote) {
            waitingNote = note;
            showProgress();
        }
    },
    log,
});

function describe(state) {
    const lines = [`${state.product ?? "Unknown phone"} in ${state.userspace === "yes" ? "fastbootd" : "the bootloader"}.`];
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

async function connect() {
    if (!device.isConnected) {
        setStatus("Connecting to the phone...");
        await device.connect();
    }
    return describe(await flow.state());
}

async function unlock() {
    return await flow.unlock(false);
}

async function unlockCritical() {
    return await flow.unlock(true);
}

async function install() {
    if (pkg === null) {
        throw new Error("Choose an image set first.");
    }
    document.getElementById("fallback").hidden = true;
    await requestWakeLock();
    try {
        await flow.install(pkg);
    } catch (error) {
        if (error instanceof SuperStopped) {
            document.getElementById("fallback").hidden = false;
        }
        throw error;
    } finally {
        await releaseWakeLock();
    }
    return "Installed. The phone restarts into DiamaneOS.";
}

async function fallback() {
    await requestWakeLock();
    try {
        await flow.fallback(pkg);
    } finally {
        await releaseWakeLock();
    }
    document.getElementById("fallback").hidden = true;
    return "Installed. The phone restarts into DiamaneOS.";
}

async function lock() {
    if (pkg === null) {
        throw new Error("Choose the image set that is installed first.");
    }
    return await flow.lock(pkg.record);
}

function recoveryLink(statusField) {
    const link = document.createElement("a");
    link.href = "recovery.html";
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

        if (progress !== undefined && progressBar !== null) {
            progressBar.hidden = false;
            progressBar.value = progress;
        }
    };

    let button = setButtonState({ id, enabled: true });
    button.onclick = async () => {
        busy = true;
        setStatus = statusCallback;
        lastProgress = ["", undefined];
        waitingNote = "";
        refresh();
        try {
            let finalStatus = await callback();
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
    const confirmed = record !== undefined
        && (!writesFirmware(record) || document.getElementById("firmware-confirm").checked);
    setButtonState({ id: Buttons.CONNECT, enabled: usb && !busy });
    setButtonState({ id: Buttons.UNLOCK, enabled: usb && !busy });
    setButtonState({ id: Buttons.UNLOCK_CRITICAL, enabled: usb && !busy });
    setButtonState({ id: Buttons.INSTALL, enabled: usb && !busy && confirmed });
    setButtonState({ id: Buttons.FALLBACK, enabled: usb && !busy && record !== undefined && flow.resume });
    setButtonState({ id: Buttons.LOCK, enabled: usb && !busy && record !== undefined && lockAllowed(record) });
    for (const id of ["folder-input", "files-input"]) {
        document.getElementById(id).disabled = busy;
    }
}

function showPackage(record) {
    const firmware = writesFirmware(record) ? record.firmware.release : null;
    document.getElementById("package-summary").textContent = [
        `DiamaneOS ${record.build_id} for the ${record.product}.`,
        firmware ? `It writes Fairphone's ${firmware} firmware.` : "",
        record.notice ?? "",
    ].join(" ").trim();
    document.getElementById("firmware-release").textContent = firmware ?? "the one in the image set";
    document.getElementById("firmware-check").hidden = firmware === null;
    document.getElementById("lock-notice").textContent = lockAllowed(record)
        ? "This image set may be installed on a locked phone."
        : record.notice ?? "This image set must stay on an unlocked phone.";
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
    pkg = null;
    busy = true;
    refresh();
    status.className = "";
    document.getElementById("package-summary").textContent = "";
    try {
        const result = await readPackage(files);
        status.textContent = `Checking ${result.needed.length} files against SHA256SUMS...`;
        progressBar.hidden = false;
        const digests = await hashFiles(result.needed.map((name) => [name, files.get(name)]), (fraction) => {
            progressBar.value = fraction;
        });
        const wrong = result.needed.filter((name) => digests.get(name) !== result.sums.get(name));
        if (wrong.length > 0) {
            throw new Error(`These files do not match SHA256SUMS: ${wrong.join(", ")}. Get the image set again.`);
        }
        pkg = { ...result, files };
        // The fastbootd steps belong to the set whose install stopped.
        flow.resume = false;
        document.getElementById("fallback").hidden = true;
        showPackage(result.record);
        status.textContent = `All ${result.needed.length} files the install uses match SHA256SUMS.`;
        log(`Image set ${result.record.build_id} checked`);
    } catch (error) {
        status.textContent = `Error: ${error.message}`;
        status.className = "error-text";
        log(`Error: ${error.message}`);
    } finally {
        progressBar.hidden = true;
        busy = false;
        refresh();
    }
}

// This doesn't really hurt, and because this page is exclusively for web install,
// we can tolerate extra logging in the console in case something goes wrong.
fastboot.setDebugLevel(1);

if ("usb" in navigator) {
    addButtonHook(Buttons.CONNECT, connect);
    addButtonHook(Buttons.UNLOCK, unlock);
    addButtonHook(Buttons.UNLOCK_CRITICAL, unlockCritical);
    addButtonHook(Buttons.INSTALL, install, { recovery: true });
    addButtonHook(Buttons.FALLBACK, fallback, { recovery: true });
    addButtonHook(Buttons.LOCK, lock);
    for (const id of ["folder-input", "files-input"]) {
        const input = document.getElementById(id);
        input.addEventListener("change", () => choosePackage(input.files));
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
