// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// Reads a DiamaneOS image set: build.json, SHA256SUMS and flash-all.sh. The
// install steps follow flash_all.commands() in diamaneos-tools, and a set whose
// flash-all.sh lists other commands is refused, so the two cannot drift apart.

// The devices this installer supports, by the product the bootloader reports
// ("getvar product") and an image set's build.json names. A new device is one
// entry here. The pages stay device-neutral and link to the website's supported
// devices page.
//
// name:   the device's name in messages.
// boot:   the button held while the phone starts, so that it stops in Fastboot Mode.
// force:  the buttons held to restart a running or stuck phone into Fastboot Mode.
export const DEVICES = Object.freeze({
    FP6: Object.freeze({ name: "Fairphone 6", boot: "Volume down", force: "Power and Volume down" }),
});

export const DEVICES_PAGE = "diamaneos.de/devices";

export function supported(product) {
    return typeof product === "string" && Object.hasOwn(DEVICES, product);
}

export function deviceName(product) {
    return supported(product) ? DEVICES[product].name : product;
}

// How to restart the phone into Fastboot Mode, from the data when the product is known.
export function restartHint(product) {
    return supported(product)
        ? `Hold ${DEVICES[product].force} until it restarts into Fastboot Mode.`
        : `Restart it into Fastboot Mode with its buttons, which ${DEVICES_PAGE} lists.`;
}

// What to hold while the phone restarts, so that it returns to Fastboot Mode.
export function bootHint(product) {
    return supported(product)
        ? `Hold ${DEVICES[product].boot} while it restarts`
        : `Use its Fastboot Mode button, which ${DEVICES_PAGE} lists, while it restarts`;
}

export const RECORD = "build.json";
export const SUMS = "SHA256SUMS";
export const SCRIPT = "flash-all.sh";
export const SUPER_EMPTY = "super_empty.img";

// Older flash-all.sh scripts check the critical partitions with this line, which writes nothing.
const SCRIPT_CHECK = "fastboot oem device-info 2>&1 | grep -q ";
const PARTITION = /^[A-Za-z0-9_-]{1,40}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SPARSE_MAGIC = 0xed26ff3a;
const AVB_FOOTER_SIZE = 64;
const VBMETA_MAGIC = 0x41564230;
const VBMETA_HEADER_SIZE = 256;

export class PackageError extends Error {
    constructor(message) {
        super(message);
        this.name = "PackageError";
    }
}

export const CRITICAL_UNLOCKED = "Device critical unlocked: true";

// What the bootloader must report before the first write, as in flash-all.sh.
// A set that writes firmware also needs CRITICAL_UNLOCKED in "oem device-info".
export function checks(record) {
    return [
        { name: "product", wanted: record.product,
          message: `This image set is for the ${deviceName(record.product)}. Connect that phone in Fastboot Mode.` },
        { name: "is-userspace", wanted: "no",
          message: "The phone is in fastbootd. Restart it into Fastboot Mode and start again." },
        { name: "unlocked", wanted: "yes",
          message: "The bootloader is locked. Unlock it first." },
    ];
}

export function writesFirmware(record) {
    return record.firmware != null && Object.keys(record.firmware).length > 0;
}

function flash(partition, file) {
    if (!PARTITION.test(partition) || !FILE.test(file)) {
        throw new PackageError(`build.json names an unexpected partition or file: ${partition} ${file}`);
    }
    return { op: "flash", partition, file };
}

export function command(step) {
    switch (step.op) {
    case "flash": return `fastboot flash ${step.partition} ${step.file}`;
    case "cancel-snapshot": return "fastboot snapshot-update cancel";
    case "wipe-super": return `fastboot wipe-super ${step.file}`;
    case "set-active": return `fastboot --set-active=${step.slot}`;
    case "reboot": return "fastboot reboot";
    case "reboot-fastboot": return "fastboot reboot fastboot";
    case "reboot-bootloader": return "fastboot reboot-bootloader";
    }
    throw new Error(`unknown step ${step.op}`);
}

// A test build is signed with the public test keys. It carries their AVB key and
// is locked only after the user ticks the page's warning, as flash-all.sh only
// with its argument "lock" and a typed yes.
export const TEST_KEYS = "public-test-keys";

// The AVB public key file the set installs, as flash_all.custom_key(): none for
// a set that must never be locked or a test build.
export function customKey(record) {
    if (record.never_lock !== false || record.signing === TEST_KEYS) {
        return null;
    }
    return record.avb_custom_key?.file || null;
}

// The public test key file a test build carries, as flash_all.test_key(), or null.
export function testKey(record) {
    if (record.signing !== TEST_KEYS || record.never_lock !== true) {
        return null;
    }
    return record.avb_custom_key?.file || null;
}

// Whether the installer may lock the bootloader after installing the set.
// testLock: the user ticked the warning of a test build before the install.
export function lockAllowed(record, testLock = false) {
    return customKey(record) !== null || (testLock && testKey(record) !== null);
}

// A clean install from the bootloader, in the order of flash_all.commands(). The
// logical partitions are written in fastbootd on an empty super layout, the rest
// in the bootloader. Before the boot images an update the OS left pending is
// cancelled, if the bootloader reports one. A set with a key ends in the
// bootloader, so that it is locked before Android starts. lock: a test build
// installs its public test key and ends there too.
export function installSteps(record, lock = false) {
    if (lock && testKey(record) === null) {
        throw new PackageError("Only a test build that carries the public test key can be locked on request.");
    }
    const slot = record.flash.slot;
    const steps = [];
    if (writesFirmware(record)) {
        for (const step of record.firmware.steps) {
            steps.push(flash(step.partition, step.image));
        }
        for (const [name, image] of Object.entries(record.firmware.reset)) {
            steps.push(flash(name, image.file));
        }
    }
    if (record.flash.logical.length > 0) {
        steps.push({ op: "cancel-snapshot" });
    }
    for (const name of record.flash.bootloader) {
        steps.push(flash(`${name}_${slot}`, `${name}.img`));
    }
    if (record.flash.logical.length > 0) {
        // An unlock leaves an erase request in misc, which recovery would run instead of fastbootd.
        // fastbootd starts from recovery on the active slot, which must be the one just written.
        steps.push(flash("misc", record.wipe.images.misc.file), { op: "set-active", slot }, { op: "reboot-fastboot" },
            { op: "wipe-super", file: SUPER_EMPTY });
        for (const name of record.flash.logical) {
            steps.push(flash(`${name}_${slot}`, `${name}.img`));
        }
        steps.push({ op: "reboot-bootloader" });
    }
    for (const [name, image] of Object.entries(record.wipe.images)) {
        steps.push(flash(name, image.file));
    }
    const key = customKey(record) ?? (lock ? testKey(record) : null);
    if (key !== null) {
        steps.push(flash("avb_custom_key", key), { op: "set-active", slot }, { op: "reboot-bootloader" });
    } else {
        steps.push({ op: "set-active", slot }, { op: "reboot" });
    }
    return steps;
}

// The steps flash-all.sh lists: for a test build, the install that ends with
// the key for a lock, then the usual ending.
export function scriptSteps(record) {
    if (testKey(record) === null) {
        return installSteps(record);
    }
    return [...installSteps(record, true), { op: "set-active", slot: record.flash.slot }, { op: "reboot" }];
}

export function scriptCommands(text) {
    return text.split("\n").map((line) => line.trim())
        .filter((line) => line.startsWith("fastboot ") && !line.startsWith(SCRIPT_CHECK));
}

export function parseSums(text) {
    const sums = new Map();
    for (const line of text.split("\n")) {
        if (line === "") {
            continue;
        }
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
        if (match === null || !FILE.test(match[2]) || sums.has(match[2])) {
            throw new PackageError("SHA256SUMS is malformed.");
        }
        sums.set(match[2], match[1]);
    }
    return sums;
}

function checkRecord(record) {
    const ok = record !== null && typeof record === "object" && record.schema_version === 1
        && typeof record.product === "string" && record.flash
        && (record.flash.slot === "a" || record.flash.slot === "b")
        && Array.isArray(record.flash.bootloader) && Array.isArray(record.flash.logical)
        && record.wipe && record.wipe.images && typeof record.wipe.images === "object"
        && (record.flash.logical.length === 0 || typeof record.wipe.images.misc?.file === "string")
        && (!writesFirmware(record) || (Array.isArray(record.firmware.steps)
            && record.firmware.reset && typeof record.firmware.reset === "object"));
    if (!ok) {
        throw new PackageError("build.json is not an image set record this installer knows.");
    }
    if (!supported(record.product)) {
        throw new PackageError(`This image set is for ${record.product}, which this installer does not support.`);
    }
}

// The files an install of the set uses: build.json, flash-all.sh and every file it writes.
export function usedFiles(record) {
    checkRecord(record);
    const names = new Set([RECORD, SCRIPT]);
    for (const step of scriptSteps(record)) {
        if (step.file !== undefined) {
            names.add(step.file);
        }
    }
    return names;
}

// The public key that signs a vbmeta image (avb_vbmeta_image.h), in the format
// of avb_pkmd.bin, or null.
export async function vbmetaKey(blob) {
    const header = new DataView(await blob.slice(0, VBMETA_HEADER_SIZE).arrayBuffer());
    if (header.byteLength < VBMETA_HEADER_SIZE || header.getUint32(0) !== VBMETA_MAGIC) {
        return null;
    }
    const start = VBMETA_HEADER_SIZE + Number(header.getBigUint64(12)) + Number(header.getBigUint64(64));
    const size = Number(header.getBigUint64(72));
    if (size === 0 || start + size > blob.size) {
        return null;
    }
    return new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
}

// A locked phone starts only what the installed key signs, so the key must sign
// the set's own vbmeta.
async function checkKey(record, files) {
    const key = customKey(record) ?? testKey(record);
    if (key === null) {
        return;
    }
    const signed = record.flash.bootloader.includes("vbmeta") && files.has("vbmeta.img")
        ? await vbmetaKey(files.get("vbmeta.img")) : null;
    const wanted = files.has(key) ? new Uint8Array(await files.get(key).arrayBuffer()) : null;
    if (signed === null || wanted === null || signed.length !== wanted.length
            || signed.some((byte, i) => byte !== wanted[i])) {
        throw new PackageError(`${key} is not the key that signs vbmeta.img. A locked phone would not start.`);
    }
}

// files: Map from file name to Blob. Reads and checks the set, hashes nothing.
export async function readPackage(files) {
    for (const name of [RECORD, SUMS, SCRIPT]) {
        if (!files.has(name)) {
            throw new PackageError(`${name} is missing. Choose the folder of an image set.`);
        }
    }
    const sums = parseSums(await files.get(SUMS).text());
    let record;
    try {
        record = JSON.parse(await files.get(RECORD).text());
    } catch {
        throw new PackageError("build.json cannot be read.");
    }
    const needed = usedFiles(record);
    const steps = installSteps(record);
    const lockSteps = testKey(record) === null ? null : installSteps(record, true);
    const expected = scriptSteps(record).map(command);
    const script = scriptCommands(await files.get(SCRIPT).text());
    if (script.length !== expected.length || script.some((line, i) => line !== expected[i])) {
        throw new PackageError("flash-all.sh lists other steps than this installer would run. Use the installer "
            + "that matches this image set, or flash-all.sh.");
    }
    for (const name of needed) {
        if (!sums.has(name)) {
            throw new PackageError(`SHA256SUMS does not list ${name}.`);
        }
        if (!files.has(name)) {
            throw new PackageError(`${name} is missing from the chosen files.`);
        }
    }
    await checkKey(record, files);
    return { record, sums, steps, lockSteps, needed: [...needed] };
}

export async function isSparse(blob) {
    if (blob.size < 4) {
        return false;
    }
    const view = new DataView(await blob.slice(0, 4).arrayBuffer());
    return view.getUint32(0, true) === SPARSE_MAGIC;
}

// As copy_avb_footer() in platform-tools fastboot: a raw image smaller than its
// partition gets its AVB footer copied to the end of the partition, where
// verified boot looks for it.
export async function withAvbFooter(blob, partitionSize) {
    if (blob.size < AVB_FOOTER_SIZE || !(partitionSize > blob.size)) {
        return blob;
    }
    const footer = blob.slice(blob.size - AVB_FOOTER_SIZE);
    const magic = new TextDecoder().decode(await footer.slice(0, 4).arrayBuffer());
    if (magic !== "AVBf") {
        return blob;
    }
    const end = partitionSize - AVB_FOOTER_SIZE;
    return new Blob([blob.slice(0, end), new Uint8Array(Math.max(0, end - blob.size)), footer]);
}

// @license-end
