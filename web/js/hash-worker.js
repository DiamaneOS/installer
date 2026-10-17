// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import { Sha256 } from "./sha256.js";
import { Sha512 } from "./sha512.js";

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async ({ data: { file, algorithm } }) => {
    try {
        const hash = algorithm === "sha512" ? new Sha512() : new Sha256();
        let next = file.slice(0, CHUNK).arrayBuffer();
        for (let offset = 0; offset < file.size; offset += CHUNK) {
            const data = new Uint8Array(await next);
            next = file.slice(offset + CHUNK, offset + 2 * CHUNK).arrayBuffer();
            hash.update(data);
            self.postMessage({ bytes: Math.min(offset + CHUNK, file.size) });
        }
        self.postMessage({ digest: hash.hex() });
    } catch (error) {
        self.postMessage({ error: `${file.name} cannot be read: ${error.message}` });
    }
};

// @license-end
