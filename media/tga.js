'use strict';
/**
 * tga.js — minimal TGA decoder for the property-grid icon preview.
 * DoW/CoH texture icons are raw or RLE truecolor/grayscale TGAs, which
 * <img> cannot render; decode to RGBA for canvas/ImageData instead.
 * Supports types 2/3 (uncompressed) and 10/11 (RLE), 24/32bpp truecolor
 * and 8bpp grayscale. Throws on anything else.
 */
(function (global) {
    function decodeTga(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 18) {
            throw new Error('not a TGA (too small)');
        }
        const idLen = bytes[0];
        const cmapType = bytes[1];
        const type = bytes[2];
        const w = bytes[12] | (bytes[13] << 8);
        const h = bytes[14] | (bytes[15] << 8);
        const bpp = bytes[16];
        const desc = bytes[17];
        if (cmapType !== 0) throw new Error('color-mapped TGA unsupported');
        const rle = type === 10 || type === 11;
        const gray = type === 3 || type === 11;
        if (!(type === 2 || type === 3 || rle)) {
            throw new Error('TGA type ' + type + ' unsupported');
        }
        if (gray ? bpp !== 8 : bpp !== 24 && bpp !== 32) {
            throw new Error('TGA bpp ' + bpp + ' unsupported');
        }
        if (!w || !h || w * h > (1 << 24)) throw new Error('bad TGA size');
        const step = gray ? 1 : bpp / 8;
        const px = w * h;
        const raw = new Uint8Array(px * step);
        let p = 18 + idLen;
        if (!rle) {
            if (p + raw.length > bytes.length) throw new Error('TGA truncated');
            raw.set(bytes.subarray(p, p + raw.length));
        } else {
            let out = 0;
            while (out < raw.length) {
                if (p >= bytes.length) throw new Error('TGA truncated');
                const hdr = bytes[p++];
                const count = (hdr & 0x7f) + 1;
                if (hdr & 0x80) {
                    if (p + step > bytes.length) throw new Error('TGA truncated');
                    for (let c = 0; c < count; c++) {
                        for (let b = 0; b < step; b++) {
                            raw[out + c * step + b] = bytes[p + b];
                        }
                    }
                    out += count * step;
                    p += step;
                } else {
                    const n = count * step;
                    if (p + n > bytes.length) throw new Error('TGA truncated');
                    raw.set(bytes.subarray(p, p + n), out);
                    out += n;
                    p += n;
                }
            }
        }
        const rgba = new Uint8Array(px * 4);
        const topOrigin = !!(desc & 0x20);
        const rightOrigin = !!(desc & 0x10);
        for (let y = 0; y < h; y++) {
            const sy = topOrigin ? y : h - 1 - y;
            for (let x = 0; x < w; x++) {
                const sx = rightOrigin ? w - 1 - x : x;
                const s = (sy * w + sx) * step;
                const d = (y * w + x) * 4;
                if (gray) {
                    rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s];
                    rgba[d + 3] = 255;
                } else {
                    rgba[d] = raw[s + 2]; // BGR(A) → RGBA
                    rgba[d + 1] = raw[s + 1];
                    rgba[d + 2] = raw[s];
                    rgba[d + 3] = step === 4 ? raw[s + 3] : 255;
                }
            }
        }
        return { width: w, height: h, rgba: rgba };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { decodeTga: decodeTga };
    } else {
        global.decodeTga = decodeTga;
    }
})(typeof window !== 'undefined' ? window : globalThis);
