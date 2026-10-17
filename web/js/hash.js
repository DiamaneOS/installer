// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

const WORKER = new URL("./hash-worker.js", import.meta.url).href;

// The page enforces Trusted Types, and this policy only allows the hash worker.
const policy = globalThis.trustedTypes?.createPolicy("installer", {
    createScriptURL(url) {
        if (url !== WORKER) {
            throw new TypeError(`unexpected script ${url}`);
        }
        return url;
    },
});

function hashOne(worker, file, onBytes, algorithm = "sha256") {
    return new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
            if (data.error !== undefined) {
                reject(new Error(data.error));
            } else if (data.digest !== undefined) {
                resolve(data.digest);
            } else {
                onBytes(data.bytes);
            }
        };
        worker.onerror = (event) => reject(new Error(event.message || "the hash worker failed"));
        worker.postMessage({ file, algorithm });
    });
}

function worker() {
    return new Worker(policy ? policy.createScriptURL(WORKER) : WORKER, { type: "module" });
}

// Resolves to the hex digest of one file, "sha256" or "sha512".
export async function hashFile(file, algorithm, onProgress) {
    const one = worker();
    try {
        return await hashOne(one, file, (bytes) => onProgress(bytes / (file.size || 1)), algorithm);
    } finally {
        one.terminate();
    }
}

// entries: [name, File] pairs. Resolves to a Map from name to SHA-256 (hex).
export async function hashFiles(entries, onProgress) {
    const queue = [...entries].sort((a, b) => b[1].size - a[1].size);
    const total = queue.reduce((sum, [, file]) => sum + file.size, 0) || 1;
    const read = new Map();
    const results = new Map();
    const count = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2, queue.length));
    const workers = Array.from({ length: count }, worker);
    const report = () => onProgress([...read.values()].reduce((sum, bytes) => sum + bytes, 0) / total);
    try {
        await Promise.all(workers.map(async (worker) => {
            while (queue.length > 0) {
                const [name, file] = queue.shift();
                results.set(name, await hashOne(worker, file, (bytes) => {
                    read.set(name, bytes);
                    report();
                }));
            }
        }));
    } finally {
        workers.forEach((worker) => worker.terminate());
    }
    return results;
}

// @license-end
