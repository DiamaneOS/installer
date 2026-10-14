// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// Reads a DiamaneOS image set: build.json, SHA256SUMS and flash-all.sh. The
// install steps follow flash_all.commands() in diamaneos-tools, and a set whose
// flash-all.sh lists other commands is refused, so the two cannot drift apart.

export const PRODUCT = "FP6";
export const RECORD = "build.json";
export const SUMS = "SHA256SUMS";
export const SCRIPT = "flash-all.sh";

// flash-all.sh checks the critical partitions with this line, which writes nothing.
const SCRIPT_CHECK = "fastboot oem device-info 2>&1 | grep -q ";
const PARTITION = /^[A-Za-z0-9_-]{1,40}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SPARSE_MAGIC = 0xed26ff3a;
const AVB_FOOTER_SIZE = 64;

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
          message: `This image set is for the ${record.product}. Connect that phone in Fastboot Mode.` },
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
    case "set-active": return `fastboot --set-active=${step.slot}`;
    case "reboot": return "fastboot reboot";
    }
    throw new Error(`unknown step ${step.op}`);
}

// A clean install from the bootloader, in the order of flash_all.commands().
export function installSteps(record) {
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
    for (const name of record.flash.bootloader) {
        steps.push(flash(`${name}_${slot}`, `${name}.img`));
    }
    if (record.flash.logical.length > 0) {
        steps.push(flash("super", "super.img"));
    }
    for (const [name, image] of Object.entries(record.wipe.images)) {
        steps.push(flash(name, image.file));
    }
    steps.push({ op: "set-active", slot }, { op: "reboot" });
    return steps;
}

// The fastbootd steps that replace "flash super" after a stall, as flash-steps
// prints them: every logical partition (the stalled flash may already have
// written the new layout), then the steps that follow super, from the bootloader.
export function fallbackSteps(record) {
    const slot = record.flash.slot;
    const steps = installSteps(record);
    const index = steps.findIndex((step) => step.op === "flash" && step.partition === "super");
    if (index < 0) {
        return null;
    }
    return {
        logical: record.flash.logical.map((name) => flash(`${name}_${slot}`, `${name}.img`)),
        after: steps.slice(index + 1),
        superIndex: index,
    };
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
        && typeof record.product === "string" && record.flash && /^[ab]$/.test(record.flash.slot)
        && Array.isArray(record.flash.bootloader) && Array.isArray(record.flash.logical)
        && record.wipe && record.wipe.images && typeof record.wipe.images === "object"
        && (!writesFirmware(record) || (Array.isArray(record.firmware.steps)
            && record.firmware.reset && typeof record.firmware.reset === "object"));
    if (!ok) {
        throw new PackageError("build.json is not an image set record this installer knows.");
    }
    if (record.product !== PRODUCT) {
        throw new PackageError(`This image set is for the ${record.product}. This installer is for the ${PRODUCT}.`);
    }
}

// Whether the set may stay on a locked phone. Sets signed with public test
// keys never may: anyone can sign images with those keys.
export function lockAllowed(record) {
    return record.never_lock === false && record.signing !== "public-test-keys";
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
    checkRecord(record);
    const steps = installSteps(record);
    const fallback = fallbackSteps(record);
    const expected = steps.map(command);
    const script = scriptCommands(await files.get(SCRIPT).text());
    if (script.length !== expected.length || script.some((line, i) => line !== expected[i])) {
        throw new PackageError("flash-all.sh lists other steps than this installer would run. Use the installer "
            + "that matches this image set, or flash-all.sh.");
    }
    const needed = new Set([RECORD, SCRIPT]);
    for (const step of [...steps, ...(fallback ? fallback.logical : [])]) {
        if (step.op === "flash") {
            needed.add(step.file);
        }
    }
    for (const name of needed) {
        if (!sums.has(name)) {
            throw new PackageError(`SHA256SUMS does not list ${name}.`);
        }
        if (!files.has(name)) {
            throw new PackageError(`${name} is missing from the chosen files.`);
        }
    }
    return { record, sums, steps, fallback, needed: [...needed] };
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
