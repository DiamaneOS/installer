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

function hashOne(worker, file, onBytes) {
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
        worker.postMessage(file);
    });
}

// entries: [name, File] pairs. Resolves to a Map from name to SHA-256 (hex).
export async function hashFiles(entries, onProgress) {
    const queue = [...entries].sort((a, b) => b[1].size - a[1].size);
    const total = queue.reduce((sum, [, file]) => sum + file.size, 0) || 1;
    const read = new Map();
    const results = new Map();
    const count = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2, queue.length));
    const url = policy ? policy.createScriptURL(WORKER) : WORKER;
    const workers = Array.from({ length: count }, () => new Worker(url, { type: "module" }));
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
