// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import {
    CRITICAL_UNLOCKED, DEVICES_PAGE, bootHint, checks, command, isSparse, lockAllowed, restartHint, supported,
    withAvbFooter, writesFirmware,
} from "./package.js";

// How long the phone may leave a USB transfer unanswered before the installer
// takes the bootloader for dead. A part of a large image takes about 20 seconds
// to send, with transfers every few ms. Other commands answer within seconds.
// Unlocking and locking may wait for the user's choice on the phone. After a
// lock the phone may start Android instead of returning to the bootloader.
export const SECONDS = { flash: 60, command: 30, confirm: 300, back: 120 };

const CONFIRM_LOCK = "On the phone, choose to lock with the volume buttons and press Power.";

export class PhoneError extends Error {
    constructor(message) {
        super(message);
        this.name = "PhoneError";
    }
}

export class StallError extends Error {
    constructor(seconds, hint) {
        super(`The phone stopped answering for ${seconds} seconds. ${hint}`);
        this.name = "StallError";
    }
}

// device: a fastboot.js FastbootDevice. ui: connect(), reconnect(message,
// seconds, back) resolving to false if the phone did not leave in time and null
// if it did not come back in time, progress(text, fraction), waiting(seconds or
// null) and log(line).
export class Flow {
    #device;
    #ui;
    #seconds;
    #transfers = new WeakMap();
    // The USB device whose bootloader stopped answering. The installer never
    // closes it: a reply cut short leaves the bootloader unable to answer.
    #dead = null;
    // The set installed on this connection, until it is locked.
    #installed = null;
    // The product the phone or the image set last named, for the restart hint.
    #product = null;

    constructor(device, ui, seconds = SECONDS) {
        this.#device = device;
        this.#ui = ui;
        this.#seconds = seconds;
        const run = device.runCommand.bind(device);
        device.runCommand = async (text) => {
            if (this.#isDead()) {
                throw new PhoneError(this.#deadMessage());
            }
            return await run(text);
        };
        // fastboot.js gives up on a getvar after 10 seconds but leaves its read
        // pending, and that read then takes the reply to the next command.
        device.getVariable = async (name) => {
            try {
                const reply = (await device.runCommand(`getvar:${name}`)).text.trim();
                return reply === "" ? null : reply;
            } catch (error) {
                if (error.name === "FastbootError" && error.status === "FAIL") {
                    return null;
                }
                throw error;
            }
        };
    }

    #isDead() {
        return this.#device.device != null && this.#device.device === this.#dead;
    }

    #deadMessage() {
        return `The phone stopped answering. ${restartHint(this.#product)} Then try again.`;
    }

    // Counts the transfers in flight on the current USB device, which changes
    // with every reconnection.
    #watch() {
        const usb = this.#device.device;
        if (usb == null || this.#transfers.has(usb)) {
            return;
        }
        const state = { pending: 0, since: 0 };
        this.#transfers.set(usb, state);
        for (const name of ["transferIn", "transferOut"]) {
            const original = usb[name].bind(usb);
            usb[name] = (...args) => {
                state.pending++;
                state.since = Date.now();
                return original(...args).finally(() => {
                    state.pending--;
                    state.since = Date.now();
                });
            };
        }
    }

    async #call(action, seconds = this.#seconds.command) {
        if (this.#isDead()) {
            throw new PhoneError(this.#deadMessage());
        }
        this.#watch();
        const usb = this.#device.device;
        const state = this.#transfers.get(usb) ?? { pending: 0 };
        const work = action();
        // A stalled transfer settles when the phone restarts.
        work.catch(() => {});
        const limit = seconds * 1000;
        let timer;
        const stalled = new Promise((_, reject) => {
            timer = setInterval(() => {
                const waited = state.pending > 0 ? Date.now() - state.since : 0;
                this.#ui.waiting(waited >= 10000 ? Math.floor(waited / 1000) : null);
                if (waited > limit) {
                    this.#dead = usb;
                    reject(new StallError(seconds, restartHint(this.#product)));
                }
            }, Math.min(1000, limit / 4));
        });
        try {
            return await Promise.race([work, stalled]);
        } finally {
            clearInterval(timer);
            this.#ui.waiting(null);
        }
    }

    async getvar(name) {
        const value = await this.#call(() => this.#device.getVariable(name));
        if (name === "product" && supported(value)) {
            this.#product = value;
        }
        return value;
    }

    async #command(text) {
        return (await this.#call(() => this.#device.runCommand(text))).text;
    }

    async #expect(name, wanted, message) {
        if (await this.getvar(name) !== wanted) {
            throw new PhoneError(message);
        }
    }

    async #restart(message, seconds) {
        if (!(await this.#ui.reconnect(message, seconds))) {
            throw new PhoneError(`The phone did not restart. ${restartHint(this.#product)} Then press Connect.`);
        }
    }

    // The phone's state as far as the installer needs it. critical and ability
    // are null in fastbootd or when the bootloader does not report them.
    async state() {
        const product = await this.getvar("product");
        const userspace = await this.getvar("is-userspace");
        const unlocked = await this.getvar("unlocked");
        let critical = null;
        let ability = null;
        if (userspace !== "yes") {
            try {
                critical = (await this.#command("oem device-info")).includes(CRITICAL_UNLOCKED);
                const match = /get_unlock_ability:\s*(\d+)/.exec(await this.#command("flashing get_unlock_ability"));
                ability = match ? Number(match[1]) : null;
            } catch (error) {
                if (error.name !== "FastbootError") {
                    throw error;
                }
            }
        }
        return { product, userspace, unlocked, critical, ability };
    }

    async #bootloaderChecks(record, critical) {
        for (const check of checks(record)) {
            await this.#expect(check.name, check.wanted, check.message);
        }
        if (critical && writesFirmware(record)
                && !(await this.#command("oem device-info")).includes(CRITICAL_UNLOCKED)) {
            throw new PhoneError("The critical partitions are locked, and the install writes firmware to them. "
                + "Unlock them first.");
        }
    }

    async #flash(partition, file, inBootloader, onProgress) {
        let image = file;
        if (inBootloader && file.size >= 64 && !(await isSparse(file))) {
            const size = parseInt(await this.getvar(`partition-size:${partition}`) ?? "", 16);
            image = await withAvbFooter(file, size);
        }
        await this.#call(() => this.#device.flashBlob(partition, image, onProgress), this.#seconds.flash);
    }

    // Runs the steps from the bootloader. The logical partitions are written in
    // fastbootd, between the restarts into it and back.
    async #run(pkg, steps) {
        const record = pkg.record;
        const sizes = steps.map((step) => (step.file === undefined ? 0 : pkg.files.get(step.file).size));
        const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
        let done = 0;
        let inBootloader = true;
        for (const [i, step] of steps.entries()) {
            const count = `(${i + 1} of ${steps.length})`;
            const where = inBootloader ? "" : " in fastbootd";
            if (step.op === "cancel-snapshot") {
                // As fastboot flashall and fastboot.js: only when the bootloader reports a pending update.
                const status = await this.getvar("snapshot-update-status");
                if (status !== null && status !== "none") {
                    this.#ui.log(`${command(step)} (status ${status})`);
                    this.#ui.progress(`Cancelling a pending update ${count}`, done / total);
                    await this.#command("snapshot-update:cancel");
                }
                continue;
            }
            this.#ui.log(command(step));
            if (step.op === "flash") {
                const label = `Writing ${step.partition}${where} ${count}`;
                this.#ui.progress(label, done / total);
                await this.#flash(step.partition, pkg.files.get(step.file), inBootloader,
                    (fraction) => this.#ui.progress(label, (done + fraction * sizes[i]) / total));
            } else if (step.op === "wipe-super") {
                // As fastboot flashall does: fastbootd writes the uploaded empty layout to super.
                this.#ui.progress(`Writing an empty super layout${where} ${count}`, done / total);
                const data = await pkg.files.get(step.file).arrayBuffer();
                await this.#call(() => this.#device.upload("super", data), this.#seconds.flash);
                await this.#command("update-super:super:wipe");
            } else if (step.op === "set-active") {
                this.#ui.progress(`Selecting and checking slot ${step.slot} ${count}`, done / total);
                await this.#command(`set_active:${step.slot}`);
                this.#ui.log("fastboot getvar current-slot");
                await this.#expect("current-slot", step.slot,
                    `The phone did not confirm slot ${step.slot}. The install stopped before restarting.`);
            } else if (step.op === "reboot-fastboot") {
                this.#ui.progress(`Starting fastbootd ${count}`, done / total);
                await this.#command(step.op);
                await this.#restart("The phone is starting fastbootd.");
                await this.#expect("is-userspace", "yes",
                    "The phone did not start fastbootd. Restart it into Fastboot Mode and install again.");
                await this.#expect("product", record.product, checks(record)[0].message);
                inBootloader = false;
            } else if (step.op === "reboot-bootloader" && i < steps.length - 1) {
                this.#ui.progress(`Returning to Fastboot Mode ${count}`, done / total);
                await this.#command(step.op);
                await this.#restart("The phone is restarting into Fastboot Mode.");
                await this.#bootloaderChecks(record, false);
                inBootloader = true;
            } else {
                await this.#command(step.op);
            }
            done += sizes[i];
        }
        this.#ui.progress("Done", 1);
    }

    // A set with a key ends in the bootloader, and the lock follows on that
    // connection. A restart in between could start Android.
    async #finish(pkg) {
        if (pkg.steps.at(-1).op !== "reboot-bootloader") {
            return null;
        }
        await this.#restart("The phone is restarting into Fastboot Mode.");
        const state = await this.state();
        if (state.product !== pkg.record.product || state.userspace === "yes" || state.unlocked !== "yes") {
            throw new PhoneError("The phone did not return to Fastboot Mode unlocked.");
        }
        this.#installed = { pkg, usb: this.#device.device };
        return state;
    }

    // Resolves to the phone's state when it waits in the bootloader for the lock.
    async install(pkg) {
        this.#installed = null;
        this.#product = pkg.record.product;
        await this.#ui.connect();
        await this.#bootloaderChecks(pkg.record, true);
        await this.#run(pkg, pkg.steps);
        return await this.#finish(pkg);
    }

    async #checkedState() {
        await this.#ui.connect();
        const state = await this.state();
        if (!supported(state.product)) {
            throw new PhoneError(`The phone reports ${state.product ?? "no product"}, which this installer does not `
                + `support. ${DEVICES_PAGE} lists the supported devices.`);
        }
        if (state.userspace === "yes") {
            throw new PhoneError("The phone is in fastbootd. Restart it into Fastboot Mode and start again.");
        }
        if (state.critical === null || state.ability === null) {
            throw new PhoneError("The bootloader did not report its lock state.");
        }
        return state;
    }

    async #lockCommand(text) {
        this.#ui.log(`fastboot ${text}`);
        try {
            await this.#call(() => this.#device.runCommand(text), this.#seconds.confirm);
        } catch (error) {
            if (error.name === "FastbootError" && error.status === "FAIL") {
                throw new PhoneError(`The bootloader refused: ${error.bootloaderMessage.trim()}`);
            }
            throw error;
        }
    }

    async unlock(critical) {
        const state = await this.#checkedState();
        if (!critical && state.unlocked === "yes") {
            return "The bootloader is already unlocked.";
        }
        if (critical && state.unlocked !== "yes") {
            throw new PhoneError("Unlock the bootloader first.");
        }
        if (critical && state.critical) {
            return "The critical partitions are already unlocked.";
        }
        if (state.ability !== 1) {
            throw new PhoneError(critical
                ? "The phone no longer allows unlocking. This happens when Android starts after the first unlock."
                : "The phone does not allow unlocking. Turn on OEM unlocking in Developer options and start again.");
        }
        await this.#lockCommand(critical ? "flashing unlock_critical" : "flashing unlock");
        return "Confirm on the phone. It erases the phone and restarts. Then bring it back to Fastboot Mode and "
            + "press Connect.";
    }

    // The phone left. Whatever restarted it, it may have started Android.
    // Returns whether that ends the chance to lock after the install.
    lost(usb) {
        if (this.#installed?.usb !== usb) {
            return false;
        }
        this.#installed = null;
        return true;
    }

    // Whether the set was installed on this connection and may be locked now.
    lockReady(pkg) {
        return this.#installed !== null && this.#installed.pkg === pkg
            && this.#installed.usb === this.#device.device && this.#device.isConnected;
    }

    // What the phone must report before each lock: the set's product, the
    // bootloader unlocked, its critical lock state, and that it allows unlocking.
    async #lockable(record) {
        const state = await this.state();
        if (state.product !== record.product || state.userspace === "yes" || state.unlocked !== "yes") {
            throw new PhoneError("The phone is not in Fastboot Mode with an unlocked bootloader. Install again, "
                + "then lock.");
        }
        if (state.critical === null) {
            throw new PhoneError("The bootloader did not report its lock state.");
        }
        if (state.ability !== 1) {
            throw new PhoneError("The phone does not allow unlocking, so it could not be unlocked again if it "
                + "failed to start. Do not lock it.");
        }
        return state;
    }

    // Android must not start between the two locks, so the phone has to come
    // back to the bootloader. Otherwise the bootloader stays unlocked.
    async #lockCritical(record) {
        await this.#lockCommand("flashing lock_critical");
        const back = await this.#ui.reconnect(`Locking the critical partitions first. ${CONFIRM_LOCK} It erases all `
            + `data and restarts. ${bootHint(record.product)}, so that it returns to Fastboot Mode. Android must `
            + "not start before the bootloader is locked.", this.#seconds.confirm, this.#seconds.back);
        if (back !== true) {
            throw new PhoneError((back === false
                ? "The phone did not restart, so the lock of the critical partitions was not confirmed."
                : "The phone did not return to Fastboot Mode in time, or it started Android.")
                + ` The installer did not lock the bootloader. ${restartHint(record.product)} Then install again `
                + "and lock straight after.");
        }
        if ((await this.#lockable(record)).critical) {
            throw new PhoneError("The critical partitions are still unlocked, so the installer did not lock the "
                + "bootloader. Install again, then lock.");
        }
    }

    // Locks a set with a key straight after its install, in the stock order: the
    // critical partitions, back to the bootloader, then the bootloader. Resolves to
    // the phone's state after the lock, or to null if it started Android instead
    // of returning to the bootloader.
    async lock(pkg) {
        const record = pkg.record;
        if (!lockAllowed(record)) {
            throw new PhoneError(record.notice || "This image set must stay on an unlocked phone.");
        }
        if (!this.lockReady(pkg)) {
            throw new PhoneError("Lock only straight after the install, while the phone stays in Fastboot Mode. "
                + "Install again, then lock.");
        }
        const state = await this.#lockable(record);
        // One lock per install, also when this one is refused or not confirmed.
        this.#installed = null;
        if (state.critical) {
            await this.#lockCritical(record);
        }
        await this.#lockCommand("flashing lock");
        const back = await this.#ui.reconnect(`${state.critical ? "Now the bootloader. " : ""}${CONFIRM_LOCK} It `
            + `erases all data and restarts. ${bootHint(record.product)}, so that it returns to Fastboot Mode for `
            + "the check.", this.#seconds.confirm, this.#seconds.back);
        if (back === false) {
            throw new PhoneError("The phone did not restart, so the lock was not confirmed. "
                + `${restartHint(record.product)} Then press Connect.`);
        }
        if (back === null) {
            return null;
        }
        const after = await this.state();
        if (after.unlocked !== "no") {
            throw new PhoneError("The bootloader is still unlocked. The phone works unlocked. To lock it, install "
                + "again and lock straight after.");
        }
        return after;
    }
}

// @license-end
