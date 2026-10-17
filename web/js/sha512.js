// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// Incremental SHA-512 (FIPS 180-4), for the signature of a release download.
// Each 64-bit word is a pair of 32-bit halves, high first.

const K = new Int32Array([
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
    0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
    0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
    0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
    0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
    0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
    0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
    0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
    0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
    0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
    0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
    0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
    0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
    0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
    0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
    0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
    0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

export class Sha512 {
    #h = new Int32Array([
        0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
        0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
    ]);
    #w = new Int32Array(160);
    #block = new Uint8Array(128);
    #used = 0;
    #bytes = 0;

    update(data) {
        let offset = 0;
        this.#bytes += data.length;
        if (this.#used > 0) {
            const take = Math.min(128 - this.#used, data.length);
            this.#block.set(data.subarray(0, take), this.#used);
            this.#used += take;
            offset = take;
            if (this.#used < 128) {
                return this;
            }
            this.#compress(this.#block, 0);
            this.#used = 0;
        }
        for (; offset + 128 <= data.length; offset += 128) {
            this.#compress(data, offset);
        }
        this.#block.set(data.subarray(offset), 0);
        this.#used = data.length - offset;
        return this;
    }

    hex() {
        const bits = this.#bytes * 8;
        const tail = new Uint8Array(this.#used < 112 ? 128 - this.#used : 256 - this.#used);
        tail[0] = 0x80;
        const view = new DataView(tail.buffer);
        view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
        view.setUint32(tail.length - 4, bits >>> 0);
        this.update(tail);
        return Array.from(this.#h, (word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
    }

    #compress(data, offset) {
        const w = this.#w;
        const h = this.#h;
        for (let i = 0; i < 32; i++) {
            const j = offset + i * 4;
            w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
        }
        for (let i = 32; i < 160; i += 2) {
            // sigma0 of w[t - 15]: rotr 1, rotr 8, shr 7.
            let xh = w[i - 30], xl = w[i - 29];
            const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
            const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
            // sigma1 of w[t - 2]: rotr 19, rotr 61, shr 6.
            xh = w[i - 4];
            xl = w[i - 3];
            const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
            const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
            let lo = (s0l >>> 0) + (s1l >>> 0) + (w[i - 13] >>> 0) + (w[i - 31] >>> 0);
            const hi = s0h + s1h + w[i - 14] + w[i - 32] + ((lo / 0x100000000) | 0);
            w[i] = hi | 0;
            w[i + 1] = lo | 0;
        }
        let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
        let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], kh = h[14], kl = h[15];
        for (let i = 0; i < 160; i += 2) {
            // Sum1 of e: rotr 14, rotr 18, rotr 41.
            const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
            const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
            const chh = (eh & fh) ^ (~eh & gh);
            const chl = (el & fl) ^ (~el & gl);
            let lo = (kl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (w[i + 1] >>> 0);
            const t1h = (kh + S1h + chh + K[i] + w[i] + ((lo / 0x100000000) | 0)) | 0;
            const t1l = lo | 0;
            // Sum0 of a: rotr 28, rotr 34, rotr 39.
            const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
            const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
            const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
            const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
            lo = (S0l >>> 0) + (majl >>> 0);
            const t2h = (S0h + majh + ((lo / 0x100000000) | 0)) | 0;
            const t2l = lo | 0;
            kh = gh;
            kl = gl;
            gh = fh;
            gl = fl;
            fh = eh;
            fl = el;
            lo = (dl >>> 0) + (t1l >>> 0);
            eh = (dh + t1h + ((lo / 0x100000000) | 0)) | 0;
            el = lo | 0;
            dh = ch;
            dl = cl;
            ch = bh;
            cl = bl;
            bh = ah;
            bl = al;
            lo = (t1l >>> 0) + (t2l >>> 0);
            ah = (t1h + t2h + ((lo / 0x100000000) | 0)) | 0;
            al = lo | 0;
        }
        const sums = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, kh, kl];
        for (let i = 0; i < 16; i += 2) {
            const lo = (h[i + 1] >>> 0) + (sums[i + 1] >>> 0);
            h[i] = (h[i] + sums[i] + ((lo / 0x100000000) | 0)) | 0;
            h[i + 1] = lo | 0;
        }
    }
}

// @license-end
