'use strict';
/**
 * dds.js — minimal DDS decoder for the property-grid icon preview.
 * DoW/CoH texture icons ship as DXT1/DXT5 (sometimes uncompressed) DDS,
 * which <img> cannot render; decode mip 0 to RGBA for canvas/ImageData.
 * Supports BC1 (DXT1), BC2 (DXT3), BC3 (DXT5), uncompressed 16/24/32bpp
 * via bit masks, and the DX10 extended header for the BC1-3/RGBA8 formats.
 * Throws on anything else.
 */
(function (global) {
    function u16(b, o) { return b[o] | (b[o + 1] << 8); }
    function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

    function rgb565(v) {
        return [
            (((v >> 11) & 31) << 3) | (((v >> 11) & 31) >> 2),
            (((v >> 5) & 63) << 2) | (((v >> 5) & 63) >> 4),
            ((v & 31) << 3) | ((v & 31) >> 2),
            255,
        ];
    }

    // BC1-style color block → palette of 4 [r,g,b,a]. threeColor mode only
    // when c0 <= c1 AND the format allows punch-through alpha (DXT1).
    function bc1Palette(block, off, allowPunch) {
        const c0 = rgb565(u16(block, off));
        const c1 = rgb565(u16(block, off + 2));
        const three = allowPunch && u16(block, off) <= u16(block, off + 2);
        const p = [c0, c1, [0, 0, 0, 0], [0, 0, 0, 0]];
        if (three) {
            p[2] = [(c0[0] + c1[0]) >> 1, (c0[1] + c1[1]) >> 1, (c0[2] + c1[2]) >> 1, 255];
            p[3] = [0, 0, 0, 0];
        } else {
            p[2] = [
                Math.round((2 * c0[0] + c1[0]) / 3),
                Math.round((2 * c0[1] + c1[1]) / 3),
                Math.round((2 * c0[2] + c1[2]) / 3),
                255,
            ];
            p[3] = [
                Math.round((c0[0] + 2 * c1[0]) / 3),
                Math.round((c0[1] + 2 * c1[1]) / 3),
                Math.round((c0[2] + 2 * c1[2]) / 3),
                255,
            ];
        }
        return p;
    }

    // DXT5 alpha block → 16 alpha values.
    function bc3Alphas(block, off) {
        const a0 = block[off], a1 = block[off + 1];
        const a = [a0, a1];
        if (a0 > a1) {
            for (let i = 1; i <= 6; i++) a.push(Math.round(((7 - i) * a0 + i * a1) / 7));
        } else {
            for (let i = 1; i <= 4; i++) a.push(Math.round(((5 - i) * a0 + i * a1) / 5));
            a.push(0, 255);
        }
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            const bitOff = i * 3;
            const bi = off + 2 + (bitOff >> 3);
            const v = (block[bi] | ((block[bi + 1] || 0) << 8) | ((block[bi + 2] || 0) << 16)) >> (bitOff & 7);
            out[i] = a[v & 7];
        }
        return out;
    }

    function putBlock(rgba, w, h, bx, by, colors, alphas) {
        for (let i = 0; i < 16; i++) {
            const x = bx * 4 + (i & 3);
            const y = by * 4 + (i >> 2);
            if (x >= w || y >= h) continue;
            const d = (y * w + x) * 4;
            const c = colors[i];
            rgba[d] = c[0];
            rgba[d + 1] = c[1];
            rgba[d + 2] = c[2];
            rgba[d + 3] = alphas ? alphas[i] : c[3];
        }
    }

    // DXT1: 8-byte blocks — u16 c0, u16 c1, u32 index bits.
    function decodeBc1(bytes, off, w, h, rgba) {
        const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
        let p = off;
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                if (p + 8 > bytes.length) throw new Error('DDS truncated');
                const pal = bc1Palette(bytes, p, true);
                const bits = u32(bytes, p + 4);
                const colors = new Array(16);
                for (let i = 0; i < 16; i++) colors[i] = pal[(bits >> (2 * i)) & 3];
                putBlock(rgba, w, h, bx, by, colors, null);
                p += 8;
            }
        }
    }

    // DXT3: 16-byte blocks — 8 bytes explicit 4-bit alpha + BC1 color block.
    function decodeBc2(bytes, off, w, h, rgba) {
        const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
        let p = off;
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                if (p + 16 > bytes.length) throw new Error('DDS truncated');
                const alphas = new Uint8Array(16);
                for (let i = 0; i < 16; i++) {
                    alphas[i] = ((bytes[p + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
                }
                const pal = bc1Palette(bytes, p + 8, false);
                const bits = u32(bytes, p + 12);
                const colors = new Array(16);
                for (let i = 0; i < 16; i++) colors[i] = pal[(bits >> (2 * i)) & 3];
                putBlock(rgba, w, h, bx, by, colors, alphas);
                p += 16;
            }
        }
    }

    // DXT5: 16-byte blocks — BC3 alpha block + BC1 color block.
    function decodeBc3(bytes, off, w, h, rgba) {
        const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
        let p = off;
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                if (p + 16 > bytes.length) throw new Error('DDS truncated');
                const alphas = bc3Alphas(bytes, p);
                const pal = bc1Palette(bytes, p + 8, false);
                const bits = u32(bytes, p + 12);
                const colors = new Array(16);
                for (let i = 0; i < 16; i++) colors[i] = pal[(bits >> (2 * i)) & 3];
                putBlock(rgba, w, h, bx, by, colors, alphas);
                p += 16;
            }
        }
    }

    // Uncompressed: extract each channel through its bitmask.
    function masked(v, mask) {
        if (!mask) return 0;
        let shift = 0, m = mask >>> 0;
        while (!(m & 1)) { m >>>= 1; shift++; }
        const bits = m;
        return Math.round((((v >>> shift) & bits) * 255) / bits);
    }

    function decodeRaw(bytes, off, w, h, rgba, bitCount, masks) {
        const bpp = bitCount / 8;
        if (!(bpp === 2 || bpp === 3 || bpp === 4)) {
            throw new Error('DDS bitcount ' + bitCount + ' unsupported');
        }
        const stride = w * bpp;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = off + y * stride + x * bpp;
                if (p + bpp > bytes.length) throw new Error('DDS truncated');
                let v = 0;
                for (let i = 0; i < bpp; i++) v |= bytes[p + i] << (8 * i);
                v = v >>> 0;
                const d = (y * w + x) * 4;
                rgba[d] = masked(v, masks[0]);
                rgba[d + 1] = masked(v, masks[1]);
                rgba[d + 2] = masked(v, masks[2]);
                rgba[d + 3] = masks[3] ? masked(v, masks[3]) : 255;
            }
        }
    }

    const FOURCC = { DXT1: 0x31545844, DXT3: 0x33545844, DXT5: 0x35545844, DX10: 0x30315844 };

    function decodeDds(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 128) {
            throw new Error('not a DDS (too small)');
        }
        if (u32(bytes, 0) !== 0x20534444) throw new Error('bad DDS magic'); // "DDS "
        const h = u32(bytes, 12);
        const w = u32(bytes, 16);
        if (!w || !h || w * h > (1 << 24)) throw new Error('bad DDS size');
        const pfFlags = u32(bytes, 80);
        const fourCC = u32(bytes, 84);
        const rgba = new Uint8Array(w * h * 4);
        let off = 128;

        if (fourCC === FOURCC.DX10) {
            // 20-byte DX10 header: map the DXGI formats we support.
            if (bytes.length < 148) throw new Error('DDS truncated');
            const dxgi = u32(bytes, 128);
            off = 148;
            if (dxgi === 71 || dxgi === 72) decodeBc1(bytes, off, w, h, rgba);
            else if (dxgi === 74 || dxgi === 75) decodeBc2(bytes, off, w, h, rgba);
            else if (dxgi === 77 || dxgi === 78) decodeBc3(bytes, off, w, h, rgba);
            else if (dxgi === 28 || dxgi === 29 || dxgi === 87 || dxgi === 88) {
                decodeRaw(bytes, off, w, h, rgba, 32, [0xff, 0xff00, 0xff0000, 0xff000000]);
            } else {
                throw new Error('DXGI format ' + dxgi + ' unsupported');
            }
        } else if (fourCC === FOURCC.DXT1) {
            decodeBc1(bytes, off, w, h, rgba);
        } else if (fourCC === FOURCC.DXT3) {
            decodeBc2(bytes, off, w, h, rgba);
        } else if (fourCC === FOURCC.DXT5) {
            decodeBc3(bytes, off, w, h, rgba);
        } else if (pfFlags & 0x40) {
            // DDPF_RGB — uncompressed, channels via bit masks.
            decodeRaw(bytes, off, w, h, rgba, u32(bytes, 88), [
                u32(bytes, 92), u32(bytes, 96), u32(bytes, 100), u32(bytes, 104),
            ]);
        } else {
            throw new Error('DDS format 0x' + fourCC.toString(16) + ' unsupported');
        }
        return { width: w, height: h, rgba: rgba };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { decodeDds: decodeDds };
    } else {
        global.decodeDds = decodeDds;
    }
})(typeof window !== 'undefined' ? window : globalThis);
