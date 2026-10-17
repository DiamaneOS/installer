// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// Downloads a release from the release host, as GrapheneOS's installer does,
// and checks it before anything reads it: the factory ZIP's SSH signature by
// DiamaneOS's factory key, then its files against its SHA256SUMS like a folder.

import { RECORD, SCRIPT, SUMS, usedFiles } from "./package.js";

export const RELEASES = "https://releases.diamaneos.de";
export const CHANNEL = "stable";
// The factory key, as diamaneos-tools pins it in config/release-keys.json.
export const FACTORY_SIGNER = "diamaneos ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB+N9xKoysBkgXsI9di16Bamn6d2wIULS5SfJazATsZ0";
export const NAMESPACE = "factory images";

const FETCH = { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" };
// <build number> <build date> <device> <channel>, as the Updater reads it.
const CHANNEL_LINE = /^([A-Za-z0-9_.-]{1,128}) ([0-9]{1,18}) ([A-Za-z0-9_-]{1,64}) ([A-Za-z0-9_-]{1,64})\n?$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SMALL = 64 * 1024;
const LARGEST = 64 * 1024 ** 3;
// Downloads and unpacked files are kept as Blobs of this size, which the browser may keep on disk.
const PART = 32 * 1024 * 1024;
const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";

export class ReleaseError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReleaseError";
    }
}

const ascii = (text) => new TextEncoder().encode(text);

function same(a, b) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function base64(text) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
        throw new ReleaseError("The release signature is malformed.");
    }
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// Reads the SSH wire format (RFC 4251): uint32 and length-prefixed strings.
function wire(bytes) {
    let at = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bad = () => new ReleaseError("The release signature is malformed.");
    return {
        raw(length) {
            if (at + length > bytes.length) {
                throw bad();
            }
            at += length;
            return bytes.subarray(at - length, at);
        },
        u32() {
            return view.getUint32(this.raw(4).byteOffset - bytes.byteOffset);
        },
        string() {
            return this.raw(this.u32());
        },
        text() {
            return new TextDecoder().decode(this.string());
        },
        end() {
            if (at !== bytes.length) {
                throw bad();
            }
        },
    };
}

function string(bytes) {
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// The Ed25519 key of an allowed_signers line: "<identity> ssh-ed25519 <key>".
function signerKey(signer) {
    const fields = signer.trim().split(/\s+/);
    if (fields.length !== 3 || fields[1] !== "ssh-ed25519") {
        throw new ReleaseError("The factory key is not an Ed25519 key.");
    }
    return base64(fields[2]);
}

// An armored SSH signature (OpenSSH PROTOCOL.sshsig) by signer in namespace.
export function parseSignature(text, signer = FACTORY_SIGNER, namespace = NAMESPACE) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 3 || lines[0] !== BEGIN || lines.at(-1) !== END) {
        throw new ReleaseError("The release signature is malformed.");
    }
    const blob = wire(base64(lines.slice(1, -1).join("")));
    if (new TextDecoder().decode(blob.raw(6)) !== "SSHSIG" || blob.u32() !== 1) {
        throw new ReleaseError("The release signature is malformed.");
    }
    const publicKey = blob.string();
    const signed = { namespace: blob.text(), reserved: blob.string(), hash: blob.text() };
    const signature = wire(blob.string());
    blob.end();
    if (!same(publicKey, signerKey(signer))) {
        throw new ReleaseError("The release is not signed with DiamaneOS's factory key. Do not install it.");
    }
    if (signed.namespace !== namespace || !["sha256", "sha512"].includes(signed.hash)) {
        throw new ReleaseError("The release signature is not one for factory images.");
    }
    const key = wire(publicKey);
    if (key.text() !== "ssh-ed25519" || signature.text() !== "ssh-ed25519") {
        throw new ReleaseError("The release signature is not an Ed25519 signature.");
    }
    const result = { ...signed, key: key.string(), signature: signature.string() };
    key.end();
    signature.end();
    if (result.key.length !== 32 || result.signature.length !== 64) {
        throw new ReleaseError("The release signature is malformed.");
    }
    return result;
}

// Checks the signature over the message whose digest (hex, of signature.hash) is given.
export async function verifySignature(signature, digest) {
    const hash = Uint8Array.from(digest.match(/../g), (pair) => parseInt(pair, 16));
    const data = concat(ascii("SSHSIG"), string(ascii(signature.namespace)), string(signature.reserved),
        string(ascii(signature.hash)), string(hash));
    let key;
    try {
        key = await crypto.subtle.importKey("raw", signature.key, { name: "Ed25519" }, false, ["verify"]);
    } catch {
        throw new ReleaseError("This browser cannot check Ed25519 signatures. Update it and try again.");
    }
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signature.signature, data))) {
        throw new ReleaseError("The release signature is not valid. Do not install this download.");
    }
}

export function parseChannel(text, product, channel = CHANNEL) {
    const match = CHANNEL_LINE.exec(text);
    if (match === null || match[3] !== product || match[4] !== channel) {
        throw new ReleaseError(`The release host has no ${channel} release for this device.`);
    }
    return { version: match[1], date: Number(match[2]) };
}

async function get(url, what, fetcher) {
    let response;
    try {
        response = await fetcher(url, FETCH);
    } catch (error) {
        throw new ReleaseError(`${what} could not be downloaded: ${error.message}`);
    }
    if (!response.ok) {
        throw new ReleaseError(`${what} could not be downloaded (HTTP ${response.status}).`);
    }
    return response;
}

async function small(response, what) {
    const blob = await read(response.body ?? new Blob().stream(), SMALL, what);
    return await blob.text();
}

// Reads a stream into a Blob of parts, so that a large file never sits in memory whole.
async function read(stream, limit, what, onBytes = () => {}) {
    const parts = [];
    let chunks = [];
    let pending = 0;
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > limit) {
            await reader.cancel();
            throw new ReleaseError(`${what} is larger than expected.`);
        }
        chunks.push(value);
        pending += value.length;
        if (pending >= PART) {
            parts.push(new Blob(chunks));
            chunks = [];
            pending = 0;
        }
        onBytes(total);
    }
    parts.push(new Blob(chunks));
    return new Blob(parts);
}

// The members of a ZIP from its central directory, with ZIP64 as Python's zipfile writes it.
export async function zipEntries(blob) {
    const bad = () => new ReleaseError("The release ZIP is damaged.");
    const tailSize = Math.min(blob.size, 22 + 0xffff);
    const tailStart = blob.size - tailSize;
    const tail = new DataView(await blob.slice(tailStart).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw bad();
    }
    let count = tail.getUint16(eocd + 10, true);
    let size = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
        if (eocd < 20 || tail.getUint32(eocd - 20, true) !== 0x07064b50) {
            throw bad();
        }
        const at = Number(tail.getBigUint64(eocd - 12, true));
        const record = new DataView(await blob.slice(at, at + 56).arrayBuffer());
        if (record.byteLength !== 56 || record.getUint32(0, true) !== 0x06064b50) {
            throw bad();
        }
        count = Number(record.getBigUint64(32, true));
        size = Number(record.getBigUint64(40, true));
        offset = Number(record.getBigUint64(48, true));
    }
    if (count > 4096 || size > 4 * 1024 * 1024 || offset + size > blob.size) {
        throw bad();
    }
    const directory = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
    const entries = [];
    let at = 0;
    for (let n = 0; n < count; n++) {
        if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== 0x02014b50) {
            throw bad();
        }
        const flags = directory.getUint16(at + 8, true);
        const method = directory.getUint16(at + 10, true);
        let compressed = directory.getUint32(at + 20, true);
        let length = directory.getUint32(at + 24, true);
        const nameLength = directory.getUint16(at + 28, true);
        const extraLength = directory.getUint16(at + 30, true);
        const commentLength = directory.getUint16(at + 32, true);
        let local = directory.getUint32(at + 42, true);
        const end = at + 46 + nameLength + extraLength + commentLength;
        if (end > directory.byteLength || (flags & 1) !== 0 || (method !== 0 && method !== 8)) {
            throw bad();
        }
        const name = new TextDecoder().decode(new Uint8Array(directory.buffer, at + 46, nameLength));
        // The ZIP64 extra field holds, in this order, each value the record marks as too large.
        for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength;) {
            const id = directory.getUint16(x, true);
            const fieldLength = directory.getUint16(x + 2, true);
            if (id === 0x0001) {
                let y = x + 4;
                const next = () => {
                    if (y + 8 > x + 4 + fieldLength) {
                        throw bad();
                    }
                    y += 8;
                    return Number(directory.getBigUint64(y - 8, true));
                };
                length = length === 0xffffffff ? next() : length;
                compressed = compressed === 0xffffffff ? next() : compressed;
                local = local === 0xffffffff ? next() : local;
            }
            x += 4 + fieldLength;
        }
        entries.push({ name, method, compressed, size: length, local });
        at = end;
    }
    return entries;
}

// The bytes of a member, unpacked into a File of that name.
export async function unzip(blob, entry, name, onBytes) {
    const bad = () => new ReleaseError(`${name} in the release ZIP is damaged.`);
    const header = new DataView(await blob.slice(entry.local, entry.local + 30).arrayBuffer());
    if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) {
        throw bad();
    }
    const start = entry.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + entry.compressed > blob.size || entry.size > LARGEST) {
        throw bad();
    }
    let stream = blob.slice(start, start + entry.compressed).stream();
    if (entry.method === 8) {
        stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
    }
    let data;
    try {
        data = await read(stream, entry.size, name, onBytes);
    } catch (error) {
        throw error instanceof ReleaseError ? error : bad();
    }
    if (data.size !== entry.size) {
        throw bad();
    }
    return new File([data], name);
}

// The release's files that the install uses, from the ZIP's one directory.
async function releaseFiles(zip, top, onProgress) {
    const entries = new Map();
    for (const entry of await zipEntries(zip)) {
        const name = entry.name.startsWith(`${top}/`) ? entry.name.slice(top.length + 1) : "";
        if (!FILE.test(name) || entries.has(name)) {
            throw new ReleaseError(`The release ZIP holds an unexpected file: ${entry.name}`);
        }
        entries.set(name, entry);
    }
    const files = new Map();
    const take = async (names) => {
        const wanted = [...names].filter((name) => !files.has(name));
        const total = wanted.reduce((sum, name) => sum + (entries.get(name)?.size ?? 0), 0) || 1;
        let done = 0;
        for (const name of wanted) {
            if (!entries.has(name)) {
                throw new ReleaseError(`${name} is missing from the release ZIP.`);
            }
            const entry = entries.get(name);
            files.set(name, await unzip(zip, entry, name, (bytes) => onProgress((done + bytes) / total)));
            done += entry.size;
        }
    };
    await take([RECORD, SUMS, SCRIPT]);
    let record;
    try {
        record = JSON.parse(await files.get(RECORD).text());
    } catch {
        throw new ReleaseError("build.json in the release cannot be read.");
    }
    await take(usedFiles(record));
    return { record, files };
}

// Downloads the channel's release for product and returns its files, as a
// folder would give them, once the signature over the whole ZIP checks out.
// digest(blob, algorithm, onProgress) resolves to the hex digest of a Blob.
export async function downloadRelease(product, digest, onProgress = () => {}, options = {}) {
    const { base = RELEASES, signer = FACTORY_SIGNER, channel = CHANNEL, fetcher = fetch } = options;
    onProgress("Finding the latest release");
    const list = await get(`${base}/${product}-${channel}`, "The release list", fetcher);
    const { version } = parseChannel(await small(list, "The release list"), product, channel);
    const top = `${product}-factory-${version}`;
    const sig = await get(`${base}/${top}.zip.sig`, "The release signature", fetcher);
    const signature = parseSignature(await small(sig, "The release signature"), signer);
    const response = await get(`${base}/${top}.zip`, `${top}.zip`, fetcher);
    const length = Number(response.headers.get("Content-Length")) || 0;
    const zip = await read(response.body ?? new Blob().stream(), LARGEST, `${top}.zip`,
        (bytes) => onProgress(`Downloading ${top}.zip`, length > 0 ? bytes / length : undefined));
    onProgress("Checking the release signature", 0);
    await verifySignature(signature, await digest(zip, signature.hash,
        (fraction) => onProgress("Checking the release signature", fraction)));
    const { record, files } = await releaseFiles(zip, top,
        (fraction) => onProgress("Unpacking the release", fraction));
    if (record.product !== product || record.build_number !== version) {
        throw new ReleaseError("The release ZIP holds another build than the release list names.");
    }
    return { version, files };
}

// @license-end
