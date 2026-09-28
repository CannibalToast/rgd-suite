'use strict';
/**
 * Tests for media/tga.js — TGA → RGBA decode used by the icon preview.
 */
const assert = require('assert');
const { test } = require('node:test');
const { decodeTga } = require('../media/tga.js');

// 18-byte TGA header; pixels follow.
function tgaHeader({ type, w, h, bpp, desc }) {
    const b = new Uint8Array(18);
    b[2] = type;
    b[12] = w & 0xff; b[13] = w >> 8;
    b[14] = h & 0xff; b[15] = h >> 8;
    b[16] = bpp;
    b[17] = desc;
    return b;
}

test('decodeTga decodes uncompressed 32bpp BGRA, top-origin', () => {
    const px = [
        0, 0, 255, 255, // red (BGRA)
        0, 255, 0, 255, // green
        255, 0, 0, 255, // blue
        255, 255, 255, 255, // white
    ];
    const tga = new Uint8Array([...tgaHeader({ type: 2, w: 2, h: 2, bpp: 32, desc: 0x20 }), ...px]);
    const out = decodeTga(tga);
    assert.strictEqual(out.width, 2);
    assert.strictEqual(out.height, 2);
    assert.deepStrictEqual([...out.rgba.slice(0, 4)], [255, 0, 0, 255]); // red
    assert.deepStrictEqual([...out.rgba.slice(4, 8)], [0, 255, 0, 255]); // green
    assert.deepStrictEqual([...out.rgba.slice(8, 12)], [0, 0, 255, 255]); // blue
});

test('decodeTga flips vertically for bottom-origin files', () => {
    const px = [
        0, 0, 255, // red BGR (stored first = bottom-left when desc lacks 0x20)
        0, 255, 0, // green
        255, 0, 0, // blue
        255, 255, 255, // white
    ];
    const tga = new Uint8Array([...tgaHeader({ type: 2, w: 2, h: 2, bpp: 24, desc: 0 }), ...px]);
    const out = decodeTga(tga);
    // Top row is the LAST stored row: blue, white.
    assert.deepStrictEqual([...out.rgba.slice(0, 4)], [0, 0, 255, 255]);
    assert.deepStrictEqual([...out.rgba.slice(4, 8)], [255, 255, 255, 255]);
    // Bottom row is the FIRST stored row: red, green.
    assert.deepStrictEqual([...out.rgba.slice(8, 12)], [255, 0, 0, 255]);
    assert.deepStrictEqual([...out.rgba.slice(12, 16)], [0, 255, 0, 255]);
});

test('decodeTga expands RLE packets (type 10)', () => {
    // 3 identical red 24bpp pixels in one run packet.
    const tga = new Uint8Array([
        ...tgaHeader({ type: 10, w: 3, h: 1, bpp: 24, desc: 0x20 }),
        0x82, 0, 0, 255, // run packet: count 3, BGR red
    ]);
    const out = decodeTga(tga);
    assert.strictEqual(out.width, 3);
    for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual([...out.rgba.slice(i * 4, i * 4 + 4)], [255, 0, 0, 255]);
    }
});

test('decodeTga rejects non-TGA input', () => {
    assert.throws(() => decodeTga(new Uint8Array([1, 2, 3])), /too small/);
    const notTga = new Uint8Array(64); // type byte 0
    assert.throws(() => decodeTga(notTga), /type 0 unsupported/);
});

console.log('tga-decode tests complete');
