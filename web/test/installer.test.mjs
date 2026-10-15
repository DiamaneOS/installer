// Run with: node --test web/test/installer.test.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { Flow, PhoneError, StallError, SuperStopped } from "../js/flow.js";
import { PackageError, SCRIPT, readPackage, scriptCommands, withAvbFooter } from "../js/package.js";
import { Sha256 } from "../js/sha256.js";

const FIXTURE = new URL("./fixture/", import.meta.url);
const FAST = { flash: 0.1, command: 0.1, confirm: 0.1 };

function fixtureFiles(changes = {}) {
    const files = new Map();
    for (const name of readdirSync(FIXTURE)) {
        files.set(name, new Blob([changes[name] ?? readFileSync(new URL(name, FIXTURE))]));
    }
    return files;
}

async function fixturePackage() {
    const files = fixtureFiles();
    return { ...(await readPackage(files)), files };
}

// Answers like an unlocked FP6 bootloader, or fastbootd after "reboot-fastboot".
// stall(text, device) returns true for the command the phone never answers.
class FakeDevice {
    constructor(stall = () => false) {
        this.stall = stall;
        this.mode = "bootloader";
        this.sent = [];
        // What flash-all.sh would show: flashes, slot changes and restarts.
        this.events = [];
        this.isConnected = true;
        this.reconnected();
    }

    // A new USB device, as after a restart.
    reconnected() {
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
            this.events.push(`fastboot ${text.replace("-", " ")}`);
            this.mode = { "reboot-fastboot": "fastbootd", "reboot-bootloader": "bootloader" }[text] ?? this.mode;
        }
        const values = { product: "FP6", unlocked: "yes", "is-userspace": this.mode === "fastbootd" ? "yes" : "no" };
        const replies = {
            "oem device-info": "Device unlocked: true\nDevice critical unlocked: true\n",
            "flashing get_unlock_ability": "get_unlock_ability: 1\n",
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

const ui = { connect: async () => {}, reconnect: async () => {}, progress() {}, waiting() {}, log() {} };

// The fake phone's events, written as flash-all.sh would write them.
function asScript(events, pkg) {
    const names = new Map([...pkg.files].map(([name, blob]) => [blob, name]));
    return events.map((event) => (Array.isArray(event) ? `fastboot flash ${event[0]} ${names.get(event[1])}` : event));
}

test("the install steps are those of the tools' flash-all.sh", async () => {
    const pkg = await fixturePackage();
    const script = scriptCommands(await pkg.files.get(SCRIPT).text());
    const fake = new FakeDevice();
    await new Flow(fake, ui).install(pkg);
    assert.deepEqual(asScript(fake.events, pkg), script);
    // The phone is checked before the first write, as flash-all.sh does.
    assert.deepEqual(fake.sent.slice(0, 4),
        ["getvar:product", "getvar:is-userspace", "getvar:unlocked", "oem device-info"]);
});

test("a set whose files or flash-all.sh disagree is refused", async () => {
    const script = readFileSync(new URL(SCRIPT, FIXTURE), "utf8");
    const record = JSON.parse(readFileSync(new URL("build.json", FIXTURE), "utf8"));
    const cases = {
        "lists other steps": { [SCRIPT]: script.replace("fastboot reboot\n", "fastboot erase userdata\nfastboot reboot\n") },
        "for the FP5": { "build.json": JSON.stringify({ ...record, product: "FP5" }) },
        "malformed": { SHA256SUMS: "not a sum\n" },
    };
    for (const [message, changes] of Object.entries(cases)) {
        await assert.rejects(readPackage(fixtureFiles(changes)), (error) =>
            error instanceof PackageError && error.message.includes(message));
    }
    const files = fixtureFiles();
    files.delete("vendor.img");
    await assert.rejects(readPackage(files), /vendor.img is missing/);
});

test("a stall after the first part of super is finished through fastbootd", async () => {
    const pkg = await fixturePackage();
    const stallOnce = (text, fake) => text === "download:1" && !fake.stalledBefore && (fake.stalledBefore = true);
    const fake = new FakeDevice(stallOnce);
    const flow = new Flow(fake, { ...ui, reconnect: async () => fake.reconnected() }, FAST);
    await assert.rejects(flow.install(pkg), SuperStopped);
    assert.equal(flow.resume, true);
    const before = fake.events.length;
    fake.reconnected();
    await flow.fallback(pkg);
    const fallback = asScript(fake.events.slice(before), pkg);
    // As flash-steps prints it for a stalled super.
    assert.deepEqual(fallback, [
        "fastboot reboot fastboot",
        "fastboot flash system_a system.img",
        "fastboot flash vendor_a vendor.img",
        "fastboot reboot bootloader",
        "fastboot flash frp frp.img",
        "fastboot flash metadata metadata.img",
        "fastboot flash misc misc.img",
        "fastboot flash userdata userdata.img",
        "fastboot --set-active=a",
        "fastboot reboot",
    ]);
    assert.equal(flow.resume, false);
});

test("a stall anywhere else stops the install, without cutting the reply short", async () => {
    const pkg = await fixturePackage();
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

test("locking needs a set that allows it and a phone that can be unlocked again", async () => {
    const record = JSON.parse(readFileSync(new URL("build.json", FIXTURE), "utf8"));
    const fake = new FakeDevice();
    const flow = new Flow(fake, ui);
    await assert.rejects(flow.lock(record), PhoneError);
    assert.equal(fake.sent.length, 0);
    await flow.lock({ ...record, never_lock: false, signing: "release-keys" });
    assert.equal(fake.sent.at(-1), "flashing lock_critical");
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
