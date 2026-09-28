'use strict';
/**
 * Tests for media/dds.js — DDS → RGBA decode used by the icon preview.
 */
const assert = require('assert');
const { test } = require('node:test');
const { decodeDds } = require('../media/dds.js');

const FOURCC_DXT1 = 0x31545844; // 'DXT1'
const FOURCC_DXT5 = 0x35545844; // 'DXT5'
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_ALPHAPIXELS = 0x1;

function ddsHeader({ w, h, fourCC, pfFlags, bitCount, masks }) {
    const b = new Uint8Array(128);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x20534444, true); // "DDS "
    dv.setUint32(4, 124, true); // header size
    dv.setUint32(12, h, true);
    dv.setUint32(16, w, true);
    dv.setUint32(76, 32, true); // ddspf size
    dv.setUint32(80, pfFlags, true);
    if (fourCC) dv.setUint32(84, fourCC, true);
    if (bitCount) dv.setUint32(88, bitCount, true);
    if (masks) masks.forEach((m, i) => dv.setUint32(92 + i * 4, m, true));
    return b;
}

test('decodeDds decodes a DXT1 block (all pixels palette[0])', () => {
    // One 4x4 block: c0=red565 c1=green565, all indices 0 → solid red.
    const block = [0x00, 0xf8, 0xe0, 0x07, 0, 0, 0, 0];
    const dds = new Uint8Array([
        ...ddsHeader({ w: 4, h: 4, fourCC: FOURCC_DXT1, pfFlags: DDPF_FOURCC }),
        ...block,
    ]);
    const out = decodeDds(dds);
    assert.strictEqual(out.width, 4);
    assert.strictEqual(out.height, 4);
    for (let i = 0; i < 16; i++) {
        assert.deepStrictEqual([...out.rgba.slice(i * 4, i * 4 + 4)], [255, 0, 0, 255]);
    }
});

test('decodeDds honors DXT1 punch-through alpha when c0 <= c1', () => {
    // c0=green565 < c1=red565 → 3-color + transparent. pixel0 idx3 → clear.
    const block = [0xe0, 0x07, 0x00, 0xf8, 3, 0, 0, 0];
    const dds = new Uint8Array([
        ...ddsHeader({ w: 4, h: 4, fourCC: FOURCC_DXT1, pfFlags: DDPF_FOURCC }),
        ...block,
    ]);
    const out = decodeDds(dds);
    assert.deepStrictEqual([...out.rgba.slice(0, 4)], [0, 0, 0, 0]); // transparent
    assert.deepStrictEqual([...out.rgba.slice(4, 8)], [0, 255, 0, 255]); // green
});

test('decodeDds decodes DXT5 alpha interpolation', () => {
    // a0=255 a1=0 (a0>a1 → 7-step interp); pixel0 idx0→255, pixel1 idx2→219.
    const alpha = [255, 0, 16, 0, 0, 0, 0, 0]; // bits: pixel1 index=2
    const color = [0x00, 0xf8, 0xe0, 0x07, 0, 0, 0, 0]; // solid red
    const dds = new Uint8Array([
        ...ddsHeader({ w: 4, h: 4, fourCC: FOURCC_DXT5, pfFlags: DDPF_FOURCC }),
        ...alpha, ...color,
    ]);
    const out = decodeDds(dds);
    assert.strictEqual(out.rgba[3], 255);
    assert.strictEqual(out.rgba[7], 219); // (6*255 + 0)/7
    assert.deepStrictEqual([...out.rgba.slice(0, 3)], [255, 0, 0]);
});

test('decodeDds decodes uncompressed 32bpp via bit masks', () => {
    const px = [0x00, 0x00, 0xff, 0xff]; // A8R8G8B8 red, LE
    const dds = new Uint8Array([
        ...ddsHeader({
            w: 1, h: 1,
            pfFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
            bitCount: 32,
            masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
        }),
        ...px,
    ]);
    const out = decodeDds(dds);
    assert.deepStrictEqual([...out.rgba], [255, 0, 0, 255]);
});

test('decodeDds rejects non-DDS input', () => {
    assert.throws(() => decodeDds(new Uint8Array([1, 2, 3])), /too small/);
    const noMagic = new Uint8Array(128);
    assert.throws(() => decodeDds(noMagic), /bad DDS magic/);
});

console.log('dds-decode tests complete');
