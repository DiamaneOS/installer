// Run with: node --test web/test/installer.test.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { Flow, PhoneError, StallError, SuperStopped } from "../js/flow.js";
import {
    PackageError, SCRIPT, command, installSteps, lockAllowed, readPackage, scriptCommands, withAvbFooter,
} from "../js/package.js";
import { Sha256 } from "../js/sha256.js";

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

async function fixturePackage(name) {
    const files = fixtureFiles(name);
    return { ...(await readPackage(files)), files };
}

function expected(name) {
    return COMMANDS[name].map((args) => `fastboot ${args.join(" ")}`);
}

// Answers like an FP6 bootloader, or fastbootd after "reboot-fastboot".
// stall(text, device) returns true for the command the phone never answers.
class FakeDevice {
    constructor(stall = () => false) {
        this.stall = stall;
        this.mode = "bootloader";
        this.unlocked = "yes";
        this.ability = 1;
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
        if (text.startsWith("set_active:")) {
            this.events.push(`fastboot --set-active=${text.slice("set_active:".length)}`);
        } else if (text.startsWith("reboot")) {
            this.events.push(`fastboot ${text}`);
            this.mode = { "reboot-fastboot": "fastbootd", "reboot-bootloader": "bootloader" }[text] ?? this.mode;
        } else if (text === "flashing lock") {
            this.locking = true;
        }
        const values = { product: "FP6", unlocked: this.unlocked, "is-userspace": this.mode === "fastbootd" ? "yes" : "no" };
        const replies = {
            "oem device-info": `Device unlocked: ${this.unlocked === "yes"}\nDevice critical unlocked: true\n`,
            "flashing get_unlock_ability": `get_unlock_ability: ${this.ability}\n`,
        };
        return { text: (text.startsWith("getvar:") ? values[text.slice("getvar:".length)] : replies[text]) ?? "" };
    }

    // As fastboot.js: an upload and a flash command per part, super in two parts.
    async flashBlob(partition, blob) {
        for (let part = 0; part < (partition === "super" ? 2 : 1); part++) {
            await this.runCommand(`download:${part}`);
            await this.runCommand(`flash:${partition}`);
        }
        this.events.push([partition, blob]);
    }
}

const ui = { connect: async () => {}, reconnect: async () => true, progress() {}, waiting() {}, log() {} };

// The fake phone restarts whenever the installer waits for a restart.
function restarting(fake) {
    return { ...ui, reconnect: async () => (fake.reconnected(), true) };
}

// The fake phone's events, written as flash-all.sh would write them.
function asScript(events, pkg) {
    const names = new Map([...pkg.files].map(([name, blob]) => [blob, name]));
    return events.map((event) => (Array.isArray(event) ? `fastboot flash ${event[0]} ${names.get(event[1])}` : event));
}

test("the install steps are those of the tools' flash_all.py and flash-all.sh", async () => {
    for (const name of FIXTURES) {
        const pkg = await fixturePackage(name);
        assert.deepEqual(pkg.steps.map(command), expected(name), name);
        assert.deepEqual(scriptCommands(await pkg.files.get(SCRIPT).text()), expected(name), name);
        const fake = new FakeDevice();
        await new Flow(fake, restarting(fake)).install(pkg);
        assert.deepEqual(asScript(fake.events, pkg), expected(name), name);
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
        "for the FP5": ["fixture", { "build.json": JSON.stringify({ ...record, product: "FP5" }) }],
        "malformed": ["fixture", { SHA256SUMS: "not a sum\n" }],
        "not the key that signs vbmeta.img": ["fixture-relock", { "avb_pkmd.bin": "another key\n" }],
    };
    for (const [message, [name, changes]] of Object.entries(cases)) {
        await assert.rejects(readPackage(fixtureFiles(name, changes)), (error) =>
            error instanceof PackageError && error.message.includes(message));
    }
    const files = fixtureFiles("fixture");
    files.delete("vendor.img");
    await assert.rejects(readPackage(files), /vendor.img is missing/);
});

test("a stall after the first part of super is finished through fastbootd", async () => {
    for (const name of FIXTURES) {
        const pkg = await fixturePackage(name);
        const stallOnce = (text, fake) => text === "download:1" && !fake.stalledBefore && (fake.stalledBefore = true);
        const fake = new FakeDevice(stallOnce);
        const flow = new Flow(fake, restarting(fake), FAST);
        await assert.rejects(flow.install(pkg), SuperStopped);
        assert.equal(flow.resume, true);
        const before = fake.events.length;
        fake.reconnected();
        await flow.fallback(pkg);
        // The steps flash-steps prints for a stalled super, then the rest of flash-all.sh.
        const all = expected(name);
        assert.deepEqual(asScript(fake.events.slice(before), pkg), [
            "fastboot reboot-fastboot",
            "fastboot flash system_a system.img",
            "fastboot flash vendor_a vendor.img",
            "fastboot reboot-bootloader",
            ...all.slice(all.indexOf("fastboot flash super super.img") + 1),
        ], name);
        assert.equal(flow.resume, false);
    }
});

test("a stall anywhere else stops the install, without cutting the reply short", async () => {
    const pkg = await fixturePackage("fixture");
    const fake = new FakeDevice((text) => text === "flash:boot_a");
    const flow = new Flow(fake, ui, FAST);
    await assert.rejects(flow.install(pkg), StallError);
    assert.equal(flow.resume, false);
    assert.notEqual(fake.device.closed, true);
    // Nothing more reaches the phone until it restarts.
    const sent = fake.sent.length;
    await assert.rejects(flow.state(), PhoneError);
    assert.equal(fake.sent.length, sent);
    fake.reconnected();
    assert.equal((await flow.state()).product, "FP6");
});

test("the bootloader is locked only straight after installing a set with a key, never critical", async () => {
    const plain = await fixturePackage("fixture");
    let fake = new FakeDevice();
    let flow = new Flow(fake, restarting(fake));
    await flow.install(plain);
    let sent = fake.sent.length;
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
            flow.lost(fake.device);
        },
        "unlocking not allowed": async (flow, fake) => {
            await flow.install(pkg);
            fake.ability = 0;
        },
    };
    for (const [why, setup] of Object.entries(refused)) {
        const fake = new FakeDevice();
        const flow = new Flow(fake, restarting(fake));
        await setup(flow, fake);
        await assert.rejects(flow.lock(pkg), PhoneError, why);
        assert.ok(!fake.sent.some((text) => text.startsWith("flashing lock")), why);
    }

    fake = new FakeDevice();
    flow = new Flow(fake, restarting(fake));
    await flow.install(pkg);
    sent = fake.sent.length;
    assert.equal((await flow.lock(pkg)).unlocked, "no");
    // Still unlocked and unlocking allowed, right before the lock.
    assert.deepEqual(fake.sent.slice(sent, sent + 6), ["getvar:product", "getvar:is-userspace", "getvar:unlocked",
        "oem device-info", "flashing get_unlock_ability", "flashing lock"]);
    assert.ok(!fake.sent.includes("flashing lock_critical"));
    await assert.rejects(flow.lock(pkg), PhoneError);

    // The phone may start Android after the lock instead of returning to the bootloader.
    fake = new FakeDevice();
    const started = { ...restarting(fake), reconnect: async (message, seconds, back) => (back ? null : (fake.reconnected(), true)) };
    flow = new Flow(fake, started);
    await flow.install(pkg);
    assert.equal(await flow.lock(pkg), null);
    assert.ok(fake.locking);
});

test("SHA-256 matches across chunk boundaries", () => {
    for (const size of [0, 55, 56, 64, 65, 1000, 70001]) {
        const data = randomBytes(size);
        for (const step of [1, 63, 64, 4096]) {
            const hash = new Sha256();
            for (let i = 0; i < size; i += step) {
                hash.update(data.subarray(i, i + step));
            }
            assert.equal(hash.hex(), createHash("sha256").update(data).digest("hex"));
        }
    }
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
