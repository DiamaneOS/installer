// Run with: node --test web/test/installer.test.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import { Flow, PhoneError, SECONDS, StallError } from "../js/flow.js";
import {
    DEVICES, PackageError, SCRIPT, command, installSteps, lockAllowed, readPackage, restartHint, scriptCommands,
    supported, withAvbFooter,
} from "../js/package.js";
import { FACTORY_SIGNER, RELEASES, ReleaseError, downloadRelease, parseSignature } from "../js/release.js";
import { Sha256 } from "../js/sha256.js";
import { Sha512 } from "../js/sha512.js";

// What the tools' flash_all.commands() returns for each fixture (make-fixture.py).
const COMMANDS = JSON.parse(readFileSync(new URL("./flash-all-commands.json", import.meta.url), "utf8"));
const FIXTURES = ["fixture", "fixture-relock"];
const FAST = { flash: 0.1, command: 0.1, confirm: 0.1 };

function fixtureFiles(name, changes = {}) {
    const directory = new URL(`./${name}/`, import.meta.url);
    const files = new Map();
    for (const file of readdirSync(directory)) {
        files.set(file, new Blob([changes[file] ?? readFileSync(new URL(file, directory))]));
    }
    return files;
}

// slot: the set's slot. For b, build.json and flash-all.sh are changed to match.
async function fixturePackage(name, slot = "a") {
    const files = fixtureFiles(name);
    if (slot !== "a") {
        const record = JSON.parse(await files.get("build.json").text());
        record.flash.slot = slot;
        const names = [...record.flash.bootloader, ...record.flash.logical].join("|");
        const lines = new RegExp(`^(fastboot --set-active=|checkslot |fastboot flash (?:${names})_)a\\b`, "gm");
        const script = (await files.get(SCRIPT).text()).replace(lines, `$1${slot}`);
        files.set("build.json", new Blob([JSON.stringify(record)]));
        files.set(SCRIPT, new Blob([script]));
    }
    return { ...(await readPackage(files)), files };
}

function expected(name) {
    return COMMANDS[name].map((args) => `fastboot ${args.join(" ")}`);
}

// Answers like the bootloader of the fixtures' device, or fastbootd after "reboot-fastboot".
// stall(text, device) returns true for the command the phone never answers.
class FakeDevice {
    constructor(stall = () => false) {
        this.stall = stall;
        this.mode = "bootloader";
        this.product = "FP6";
        this.unlocked = "yes";
        this.critical = true;
        this.ability = 1;
        this.snapshot = "none";
        this.slot = "a";
        this.slotAtFastboot = null;
        // The erase request an unlock leaves in misc, and whether recovery found one when fastbootd started.
        this.eraseRequest = false;
        this.eraseAtFastboot = null;
        this.responses = new Map();
        this.sent = [];
        // What flash-all.sh would show: flashes, slot changes and restarts.
        this.events = [];
        this.isConnected = true;
        this.reconnected();
    }

    // A new USB device, as after a restart.
    reconnected() {
        if (this.locking) {
            this.unlocked = "no";
            this.locking = false;
        }
        if (this.lockingCritical) {
            this.critical = false;
            this.lockingCritical = false;
        }
        const usb = {
            transferOut: async () => ({ status: "ok" }),
            transferIn: () => (usb.stalled ? new Promise(() => {}) : Promise.resolve({})),
            close: async () => {
                usb.closed = true;
            },
        };
        this.device = usb;
    }

    async runCommand(text) {
        this.sent.push(text);
        this.device.stalled = this.stall(text, this);
        await this.device.transferOut();
        await this.device.transferIn();
        if (this.responses.has(text)) {
            const response = this.responses.get(text);
            if (response instanceof Error) {
                throw response;
            }
            return { text: response };
        }
        if (text.startsWith("set_active:")) {
            this.slot = text.slice("set_active:".length);
            this.events.push(`fastboot --set-active=${this.slot}`);
        } else if (text.startsWith("reboot")) {
            if (text === "reboot-fastboot") {
                this.slotAtFastboot = this.slot;
                this.eraseAtFastboot = this.eraseRequest;
            }
            this.events.push(text === "reboot-fastboot" ? "fastboot reboot fastboot" : `fastboot ${text}`);
            this.mode = { "reboot-fastboot": "fastbootd", "reboot-bootloader": "bootloader" }[text] ?? this.mode;
        } else if (text === "snapshot-update:cancel") {
            this.events.push("fastboot snapshot-update cancel");
            this.snapshot = "none";
        } else if (text === "update-super:super:wipe") {
            this.events.push({ wipe: this.uploaded, mode: this.mode });
        } else if (text === "flashing lock") {
            this.locking = true;
        } else if (text === "flashing lock_critical") {
            this.lockingCritical = true;
        }
        const values = { product: this.product, unlocked: this.unlocked, "is-userspace": this.mode === "fastbootd" ? "yes" : "no",
            "snapshot-update-status": this.snapshot, "current-slot": this.slot };
        const replies = {
            "oem device-info": `Device unlocked: ${this.unlocked === "yes"}\n`
                + `Device critical unlocked: ${this.critical}\n`,
            "flashing get_unlock_ability": `get_unlock_ability: ${this.ability}\n`,
        };
        return { text: (text.startsWith("getvar:") ? values[text.slice("getvar:".length)] : replies[text]) ?? "" };
    }

    // As fastboot.js: an upload, then the flash command.
    async flashBlob(partition, blob) {
        await this.runCommand("download:0");
        await this.runCommand(`flash:${partition}`);
        this.events.push([partition, blob, this.mode]);
        if (partition === "misc") {
            this.eraseRequest = false;
        }
    }

    async upload(partition, buffer) {
        await this.runCommand(`download:${buffer.byteLength}`);
        this.uploaded = new Uint8Array(buffer);
    }
}

const ui = { connect: async () => {}, reconnect: async () => true, leave: async () => true, progress() {}, waiting() {},
    log() {} };

// The fake phone restarts whenever the installer waits for a restart.
function restarting(fake) {
    return { ...ui, reconnect: async () => (fake.reconnected(), true) };
}

// The restarts after the lock commands, which wait with a bound for the return,
// take the next outcome: true when the phone is back in the bootloader, null
// when it is not back in time, false when it did not restart. A function first
// changes the phone, as the user or Android would, before it is back.
function lockRestarts(fake, outcomes) {
    const asked = [];
    const callbacks = { ...ui, reconnect: async (message, seconds, back) => {
        if (back !== undefined) {
            asked.push({ message, back });
            const outcome = outcomes.length > 0 ? outcomes.shift() : true;
            if (outcome === null || outcome === false) {
                return outcome;
            }
            if (typeof outcome === "function") {
                outcome(fake);
            }
        }
        fake.reconnected();
        return true;
    } };
    return { callbacks, asked };
}

// The fake phone's events, written as flash-all.sh would write them. make-fixture.py
// writes "fixture <name>" into each image, which names the uploaded super layout.
function asScript(events, pkg) {
    const names = new Map([...pkg.files].map(([name, blob]) => [blob, name]));
    return events.map((event) => {
        if (Array.isArray(event)) {
            return `fastboot flash ${event[0]} ${names.get(event[1])}`;
        }
        if (event.wipe !== undefined) {
            return `fastboot wipe-super ${new TextDecoder().decode(event.wipe).slice("fixture ".length).trim()}`;
        }
        return event;
    });
}

test("the install steps are those of the tools' flash_all.py and flash-all.sh", async () => {
    for (const name of FIXTURES) {
        const pkg = await fixturePackage(name);
        assert.deepEqual(pkg.steps.map(command), expected(name), name);
        assert.deepEqual(scriptCommands(await pkg.files.get(SCRIPT).text()), expected(name), name);
        // After an update the phone may still have one pending, which the install cancels.
        const fake = new FakeDevice();
        fake.snapshot = "merging";
        await new Flow(fake, restarting(fake)).install(pkg);
        assert.deepEqual(asScript(fake.events, pkg), expected(name), name);
        // Without one, nothing is cancelled, as in flash-all.sh.
        const plain = new FakeDevice();
        await new Flow(plain, restarting(plain)).install(pkg);
        assert.deepEqual(asScript(plain.events, pkg),
            expected(name).filter((line) => line !== "fastboot snapshot-update cancel"), name);
        assert.ok(!plain.sent.includes("snapshot-update:cancel"));
        // The phone is checked before the first write, as flash-all.sh does.
        assert.deepEqual(fake.sent.slice(0, 4),
            ["getvar:product", "getvar:is-userspace", "getvar:unlocked", "oem device-info"]);
    }
    // A set that must never be locked gets no key and starts Android, even if it names one.
    const record = (await fixturePackage("fixture-relock")).record;
    const never = installSteps({ ...record, never_lock: true }).map(command);
    assert.deepEqual(never, expected("fixture"));
    assert.ok(!never.some((line) => line.includes("avb_custom_key") || line.includes("flashing")));
    assert.equal(lockAllowed({ ...record, never_lock: true }), false);
});

test("a set whose files or flash-all.sh disagree is refused", async () => {
    const script = readFileSync(new URL(`./fixture/${SCRIPT}`, import.meta.url), "utf8");
    const record = JSON.parse(readFileSync(new URL("./fixture/build.json", import.meta.url), "utf8"));
    const cases = {
        "lists other steps": ["fixture", { [SCRIPT]: script.replace("fastboot reboot\n", "fastboot erase userdata\nfastboot reboot\n") }],
        "for FP5, which this installer does not support": ["fixture", { "build.json": JSON.stringify({ ...record, product: "FP5" }) }],
        "for constructor, which": ["fixture", { "build.json": JSON.stringify({ ...record, product: "constructor" }) }],
        "malformed": ["fixture", { SHA256SUMS: "not a sum\n" }],
        "not the key that signs vbmeta.img": ["fixture-relock", { "avb_pkmd.bin": "another key\n" }],
    };
    for (const [message, [name, changes]] of Object.entries(cases)) {
        await assert.rejects(readPackage(fixtureFiles(name, changes)), (error) =>
            error instanceof PackageError && error.message.includes(message));
    }
    // Older sets: without the slot check before fastbootd, or without clearing misc first.
    for (const legacy of [script.replace("fastboot --set-active=a\ncheckslot a\nfastboot reboot fastboot\n",
        "fastboot flash misc misc.img\nfastboot reboot fastboot\n"),
    script.replace("fastboot flash misc misc.img\nfastboot --set-active=a\n", "fastboot --set-active=a\n")]) {
        assert.notEqual(legacy, script);
        await assert.rejects(readPackage(fixtureFiles("fixture", { [SCRIPT]: legacy })), /lists other steps/);
    }
    const files = fixtureFiles("fixture");
    files.delete("vendor.img");
    await assert.rejects(readPackage(files), /vendor.img is missing/);
});

test("misc is written before fastbootd, so recovery does not run an erase an unlock left", async () => {
    const pkg = await fixturePackage("fixture-relock");
    const fake = new FakeDevice();
    fake.eraseRequest = true;
    await new Flow(fake, restarting(fake)).install(pkg);
    assert.equal(fake.eraseAtFastboot, false);
    const enter = fake.sent.indexOf("reboot-fastboot");
    assert.deepEqual(fake.sent.slice(enter - 4, enter - 2), ["download:0", "flash:misc"]);
    // The wipe images write it again at the end.
    assert.equal(fake.sent.filter((text) => text === "flash:misc").length, 2);
});

test("only a supported phone that matches the image set is unlocked or installed", async () => {
    assert.ok(supported("FP6") && !supported("FP5") && !supported("toString") && !supported(null));
    // Unlocking needs no image set: the phone must be a supported device.
    for (const product of ["FP5", "__proto__", null]) {
        const fake = new FakeDevice();
        fake.product = product;
        fake.unlocked = "no";
        await assert.rejects(new Flow(fake, ui).unlock(false), /does not support/);
        assert.ok(!fake.sent.some((text) => /^flashing (un)?lock/.test(text)), String(product));
    }
    const fake = new FakeDevice();
    fake.unlocked = "no";
    await new Flow(fake, ui).unlock(false);
    assert.ok(fake.sent.includes("flashing unlock"));
    // Installing: the phone must report the set's product before the first write.
    const pkg = await fixturePackage("fixture-relock");
    const other = new FakeDevice();
    other.product = "FP5";
    await assert.rejects(new Flow(other, restarting(other)).install(pkg), new RegExp(`for the ${DEVICES.FP6.name}`));
    assert.deepEqual(other.sent, ["getvar:product"]);
    assert.deepEqual(other.events, []);
    // A restart hint takes the buttons from the data.
    assert.match(restartHint("FP6"), new RegExp(DEVICES.FP6.force));
    assert.doesNotMatch(restartHint("FP5"), /undefined/);
});

test("the logical partitions are written in fastbootd, everything else in the bootloader", async () => {
    for (const name of FIXTURES) {
        const pkg = await fixturePackage(name);
        const fake = new FakeDevice();
        await new Flow(fake, restarting(fake)).install(pkg);
        const writes = fake.events.filter((event) => typeof event !== "string")
            .map((event) => (Array.isArray(event) ? [event[0], event[2]] : ["wipe-super", event.mode]));
        assert.deepEqual(writes.filter(([, mode]) => mode === "fastbootd").map(([what]) => what),
            ["wipe-super", "system_a", "vendor_a"], name);
        // Back in the bootloader, the phone is checked again before the data images.
        const back = fake.sent.lastIndexOf("reboot-bootloader", fake.sent.indexOf("flash:frp"));
        assert.deepEqual(fake.sent.slice(back + 1, back + 4), ["getvar:product", "getvar:is-userspace",
            "getvar:unlocked"], name);
    }
});

test("the set's slot is selected and confirmed before fastbootd and at the end", async () => {
    for (const name of FIXTURES) {
        for (const slot of ["a", "b"]) {
            const pkg = await fixturePackage(name, slot);
            const fake = new FakeDevice();
            fake.slot = slot === "a" ? "b" : "a";
            await new Flow(fake, restarting(fake)).install(pkg);
            const enter = fake.sent.indexOf("reboot-fastboot");
            assert.equal(fake.slotAtFastboot, slot);
            assert.deepEqual(fake.sent.slice(enter - 2, enter + 1), [`set_active:${slot}`, "getvar:current-slot",
                "reboot-fastboot"]);
            const last = fake.sent.lastIndexOf(`set_active:${slot}`);
            assert.deepEqual(fake.sent.slice(last, last + 3), [`set_active:${slot}`, "getvar:current-slot",
                name === "fixture-relock" ? "reboot-bootloader" : "reboot"]);
            for (const partition of [...pkg.record.flash.bootloader, ...pkg.record.flash.logical]) {
                assert.ok(fake.sent.includes(`flash:${partition}_${slot}`), `${name} ${partition}_${slot}`);
            }
        }
    }
});

test("a slot the phone does not confirm stops the install before the next restart", async () => {
    const refused = () => Object.assign(new Error("refused"), { name: "FastbootError", status: "FAIL" });
    const failures = {
        "selection refused": ["set_active:b", refused()],
        "query refused": ["getvar:current-slot", refused()],
        "other slot": ["getvar:current-slot", "a"],
        "two slots": ["getvar:current-slot", "b\na"],
    };
    for (const end of [false, true]) {
        for (const [why, [text, response]] of Object.entries(failures)) {
            const pkg = await fixturePackage("fixture-relock", "b");
            const fake = new FakeDevice();
            const responses = new Map([[text, response]]);
            // At the end: only once the phone is back from fastbootd.
            fake.responses = end ? new Map() : responses;
            const flow = new Flow(fake, { ...ui, reconnect: async () => {
                fake.reconnected();
                if (fake.mode === "bootloader") {
                    fake.responses = responses;
                }
                return true;
            } });
            await assert.rejects(flow.install(pkg), (error) => error instanceof PhoneError || error === response,
                why);
            assert.equal(fake.sent.at(-1), text, why);
            assert.deepEqual(fake.sent.filter((line) => line.startsWith("reboot")),
                end ? ["reboot-fastboot", "reboot-bootloader"] : [], why);
            assert.equal(flow.lockReady(pkg), false);
        }
    }
});

test("only an exact a or b target slot is admitted", async () => {
    const record = JSON.parse(readFileSync(new URL("./fixture/build.json", import.meta.url), "utf8"));
    for (const slot of ["a\n", "b\r", "a\nb", "", "A", null, ["a"]]) {
        const changed = { ...record, flash: { ...record.flash, slot } };
        await assert.rejects(readPackage(fixtureFiles("fixture", { "build.json": JSON.stringify(changed) })),
            (error) => error instanceof PackageError && error.message.includes("not an image set record"));
    }
});

test("a stall stops the install, without cutting the reply short", async () => {
    const pkg = await fixturePackage("fixture");
    const fake = new FakeDevice((text) => text === "flash:boot_a");
    const flow = new Flow(fake, ui, FAST);
    await assert.rejects(flow.install(pkg), StallError);
    assert.notEqual(fake.device.closed, true);
    // Nothing more reaches the phone until it restarts.
    const sent = fake.sent.length;
    await assert.rejects(flow.state(), PhoneError);
    assert.equal(fake.sent.length, sent);
    fake.reconnected();
    assert.equal((await flow.state()).product, "FP6");
});

test("the bootloader is locked only straight after installing a set with a key", async () => {
    const plain = await fixturePackage("fixture");
    let fake = new FakeDevice();
    let flow = new Flow(fake, restarting(fake));
    await flow.install(plain);
    const sent = fake.sent.length;
    await assert.rejects(flow.lockCritical(plain), PhoneError);
    await assert.rejects(flow.lock(plain), PhoneError);
    assert.equal(fake.sent.length, sent);

    const pkg = await fixturePackage("fixture-relock");
    const refused = {
        "not installed": async () => {},
        "restarted after the install": async (flow, fake) => {
            await flow.install(pkg);
            fake.reconnected();
        },
        "disconnected after the install": async (flow, fake) => {
            await flow.install(pkg);
            assert.equal(flow.lost(fake.device), "critical");
        },
        "unlocking not allowed": async (flow, fake) => {
            await flow.install(pkg);
            fake.ability = 0;
        },
        "lock state not reported": async (flow, fake) => {
            await flow.install(pkg);
            fake.responses.set("oem device-info", Object.assign(new Error("unknown"), { name: "FastbootError" }));
        },
    };
    for (const [why, setup] of Object.entries(refused)) {
        const fake = new FakeDevice();
        const flow = new Flow(fake, restarting(fake));
        await setup(flow, fake);
        await assert.rejects(flow.lockCritical(pkg), PhoneError, why);
        assert.ok(!fake.sent.some((text) => text.startsWith("flashing lock")), why);
    }

    fake = new FakeDevice();
    flow = new Flow(fake, restarting(fake));
    await flow.install(pkg);
    await flow.lockCritical(pkg);
    await flow.lock(pkg);
    await assert.rejects(flow.lockCritical(pkg), PhoneError);
    await assert.rejects(flow.lock(pkg), PhoneError);
});

const LOCK_CHECKS = ["getvar:product", "getvar:is-userspace", "getvar:unlocked", "oem device-info",
    "flashing get_unlock_ability"];

test("the critical partitions are locked first, then the bootloader once the phone is back", async () => {
    const pkg = await fixturePackage("fixture-relock");
    const fake = new FakeDevice();
    const { callbacks, asked } = lockRestarts(fake, [true]);
    const left = [];
    const flow = new Flow(fake, { ...callbacks, leave: async (message) => (left.push(message), true) });
    await flow.install(pkg);
    assert.equal(flow.lockStep(pkg), "critical");
    // The bootloader lock waits for its turn.
    await assert.rejects(flow.lock(pkg), PhoneError);
    let sent = fake.sent.length;
    assert.equal((await flow.lockCritical(pkg)).critical, false);
    // Still unlocked and unlocking allowed before the lock, and the critical partitions locked once back.
    assert.deepEqual(fake.sent.slice(sent), [...LOCK_CHECKS, "flashing lock_critical", ...LOCK_CHECKS]);
    assert.match(asked[0].message, new RegExp(`Hold ${DEVICES.FP6.boot} while it restarts.*Android must not start`));
    assert.equal(asked[0].back, SECONDS.back);
    assert.equal(flow.lockStep(pkg), "bootloader");
    // The last lock does not wait for the phone to come back: it erases itself and starts the OS.
    sent = fake.sent.length;
    await flow.lock(pkg);
    assert.deepEqual(fake.sent.slice(sent), [...LOCK_CHECKS, "flashing lock"]);
    assert.equal(asked.length, 1);
    assert.match(left[0], /starts DiamaneOS/);
    assert.equal(flow.lockStep(pkg), null);

    // A lock the phone does not confirm leaves the bootloader unlocked.
    const declined = new FakeDevice();
    const restarts = lockRestarts(declined, [true]);
    const declinedFlow = new Flow(declined, { ...restarts.callbacks, leave: async () => false });
    await declinedFlow.install(pkg);
    await declinedFlow.lockCritical(pkg);
    await assert.rejects(declinedFlow.lock(pkg), /not confirmed/);
});

test("the bootloader is not locked unless the phone is back in the bootloader after the critical lock", async () => {
    const pkg = await fixturePackage("fixture-relock");
    const stops = {
        "not back in time, or Android started": [null, restartHint("FP6")],
        "not restarted": [false, "not confirmed"],
        "Android started and turned unlocking off": [(fake) => (fake.ability = 0), "does not allow unlocking"],
        "back in fastbootd": [(fake) => (fake.mode = "fastbootd"), "not in Fastboot Mode"],
        "critical lock declined": [(fake) => (fake.lockingCritical = false), "still unlocked"],
    };
    for (const [why, [outcome, message]] of Object.entries(stops)) {
        const fake = new FakeDevice();
        const flow = new Flow(fake, lockRestarts(fake, [outcome]).callbacks);
        await flow.install(pkg);
        await assert.rejects(flow.lockCritical(pkg),
            (error) => error instanceof PhoneError && error.message.includes(message), why);
        await assert.rejects(flow.lock(pkg), PhoneError, why);
        assert.deepEqual(fake.sent.filter((text) => text.startsWith("flashing lock")), ["flashing lock_critical"], why);
        assert.equal(fake.unlocked, "yes", why);
        assert.equal(flow.lockStep(pkg), null, why);
    }
});

test("with the critical partitions already locked, only the bootloader is locked", async () => {
    const pkg = await fixturePackage("fixture-relock");
    const fake = new FakeDevice();
    // A set without firmware may end on a phone whose critical partitions are locked.
    const flow = new Flow(fake, { ...ui, reconnect: async () => {
        fake.reconnected();
        fake.critical = !fake.sent.includes("flash:avb_custom_key");
        return true;
    } });
    await flow.install(pkg);
    assert.equal(flow.lockStep(pkg), "bootloader");
    await assert.rejects(flow.lockCritical(pkg), PhoneError);
    await flow.lock(pkg);
    assert.deepEqual(fake.sent.filter((text) => text.startsWith("flashing lock")), ["flashing lock"]);
});

test("an unlock waits for the phone to come back to Fastboot Mode and reads its state", async () => {
    for (const critical of [false, true]) {
        const fake = new FakeDevice();
        if (critical) {
            fake.critical = false;
        } else {
            fake.unlocked = "no";
        }
        const asked = [];
        const flow = new Flow(fake, { ...ui, reconnect: async (message, seconds, back) => {
            asked.push({ message, back });
            fake.unlocked = "yes";
            fake.critical = critical;
            fake.reconnected();
            return true;
        } });
        const state = await flow.unlock(critical);
        assert.ok(fake.sent.includes(critical ? "flashing unlock_critical" : "flashing unlock"));
        assert.deepEqual([state.unlocked, state.critical], ["yes", critical]);
        assert.equal(flow.known(), state);
        assert.match(asked[0].message, new RegExp(`Hold ${DEVICES.FP6.boot} while it restarts`));
        assert.equal(asked[0].back, SECONDS.back);
    }
    // Not back in time, for example because Android started, or not restarted at all.
    for (const [outcome, result] of [[null, null], [false, /not confirmed/]]) {
        const fake = new FakeDevice();
        fake.unlocked = "no";
        const unlock = new Flow(fake, { ...ui, reconnect: async () => outcome }).unlock(false);
        if (result === null) {
            assert.equal(await unlock, null);
        } else {
            await assert.rejects(unlock, result);
        }
    }
});

test("SHA-256 and SHA-512 match across chunk boundaries", () => {
    for (const [Hash, name] of [[Sha256, "sha256"], [Sha512, "sha512"]]) {
        for (const size of [0, 55, 56, 64, 65, 111, 112, 128, 129, 1000, 70001]) {
            const data = randomBytes(size);
            for (const step of [1, 63, 64, 128, 4096]) {
                const hash = new Hash();
                for (let i = 0; i < size; i += step) {
                    hash.update(data.subarray(i, i + step));
                }
                assert.equal(hash.hex(), createHash(name).update(data).digest("hex"), `${name} ${size} ${step}`);
            }
        }
    }
});

// Serves fixture-release as the release host, with changes to its files, and lists the requests.
async function releaseHost(changes = {}) {
    const directory = new URL("./fixture-release/", import.meta.url);
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url);
        const name = request.url.slice(1);
        try {
            const data = changes[name] ?? readFileSync(new URL(name, directory));
            response.writeHead(200, { "Content-Length": data.length, "Access-Control-Allow-Origin": "*" });
            response.end(data);
        } catch {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close(),
        signer: readFileSync(new URL("allowed_signers", directory), "utf8") };
}

// As in the browser: the installer's own SHA-256 and SHA-512.
async function digest(blob, algorithm) {
    const hash = algorithm === "sha512" ? new Sha512() : new Sha256();
    return hash.update(new Uint8Array(await blob.arrayBuffer())).hex();
}

test("a release download is used only once its signature by the factory key checks out", async () => {
    assert.equal(FACTORY_SIGNER, COMMANDS.factory_signer);
    const release = (name) => readFileSync(new URL(`./fixture-release/${name}`, import.meta.url));
    // A channel file that names another device than the one asked for.
    const host = await releaseHost({ "FP5-stable": release("FP6-stable") });
    try {
        const { version, files } = await downloadRelease("FP6", digest, () => {}, host);
        assert.equal(version, "2026101700");
        assert.deepEqual(host.requests, ["/FP6-stable", `/FP6-factory-${version}.zip.sig`,
            `/FP6-factory-${version}.zip`]);
        // Only the files the install uses, not super.img.
        const pkg = await readPackage(files);
        assert.deepEqual(pkg.steps.map(command), expected("fixture-relock"));
        assert.ok(!files.has("super.img"));
        // Another key, another namespace, or another device's channel.
        await assert.rejects(downloadRelease("FP6", digest, () => {}, { ...host, signer: FACTORY_SIGNER }),
            /not signed with DiamaneOS's factory key/);
        const signature = release("FP6-factory-2026101700.zip.sig").toString();
        assert.throws(() => parseSignature(signature, host.signer, "file"), ReleaseError);
        await assert.rejects(downloadRelease("FP5", digest, () => {}, host), /no stable release/);
    } finally {
        host.close();
    }
    // A changed byte anywhere in the ZIP fails the signature before the ZIP is read.
    const zip = release("FP6-factory-2026101700.zip");
    const changed = Buffer.from(zip);
    changed[zip.length - 30] ^= 1;
    const tampered = await releaseHost({ "FP6-factory-2026101700.zip": changed });
    try {
        await assert.rejects(downloadRelease("FP6", digest, () => {}, tampered), /signature is not valid/);
    } finally {
        tampered.close();
    }
});

test("the page may connect only to the release host, and its links leave a running install open", () => {
    const web = new URL("../", import.meta.url);
    const conf = readFileSync(new URL("nginx/installer.conf", web), "utf8");
    const csp = conf.match(/Content-Security-Policy "([^"]+)"/)[1];
    assert.match(csp, new RegExp(`(^|; )connect-src ${RELEASES};`));
    const page = readFileSync(new URL("index.html", web), "utf8");
    const links = [...page.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/href="#/.test(tag)
        && !tag.includes('class="skip"'));
    assert.ok(links.length > 10);
    assert.deepEqual(links.filter((tag) => !tag.includes('target="_blank"')), []);
});

test("an AVB footer moves to the end of a larger partition, as fastboot does", async () => {
    const footer = new Uint8Array(64);
    footer.set(new TextEncoder().encode("AVBf"));
    const image = new Blob([new Uint8Array(1000).fill(7), footer]);
    const moved = new Uint8Array(await (await withAvbFooter(image, 4096)).arrayBuffer());
    assert.equal(moved.length, 4096);
    assert.deepEqual(moved.slice(0, 1064), new Uint8Array(await image.arrayBuffer()));
    assert.deepEqual(moved.slice(4032), footer);
    assert.equal(await withAvbFooter(image, image.size), image);
    assert.equal(await withAvbFooter(new Blob([new Uint8Array(1064)]), 4096).then((b) => b.size), 1064);
});

test("every page gets its font from its own origin, which both policies allow", () => {
    const web = new URL("../", import.meta.url);
    const css = readFileSync(new URL("style.css", web), "utf8");
    const fonts = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(fonts, ["fonts/SofiaSans-latin-wght.woff2"]);
    assert.ok(readFileSync(new URL(fonts[0], web)).length > 0);
    for (const policy of ["installer.conf", "general.conf"]) {
        const csp = readFileSync(new URL(`nginx/${policy}`, web), "utf8").match(/Content-Security-Policy "([^"]+)"/)[1];
        assert.match(csp, /(^|; )font-src 'self';/);
    }
});
