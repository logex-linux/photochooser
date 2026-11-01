import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PC = require('../src/core.js');

test('sorts names the way Finder does', () => {
    const names = ['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg', 'a.png'];
    assert.deepEqual(PC.sortByName(names), ['a.png', 'IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
});

test('separates browser-decodable formats from desktop-only ones', () => {
    assert.equal(PC.isBrowserPhoto('a.JPG'), true);
    assert.equal(PC.isBrowserPhoto('a.heic'), false);
    assert.equal(PC.isDesktopPhoto('a.heic'), true);
    assert.equal(PC.isDesktopPhoto('notes.txt'), false);
});

test('clamps indices and formats progress', () => {
    assert.equal(PC.clampIndex(-4, 10), 0);
    assert.equal(PC.clampIndex(42, 10), 9);
    assert.equal(PC.clampIndex(3, 0), 0);
    assert.equal(PC.formatProgress(0, 12), '1 / 12');
    assert.equal(PC.formatProgress(0, 0), '0 张');
});

test('never upscales when computing decode size', () => {
    assert.deepEqual(PC.targetDimensions(800, 600, 2400), { width: 800, height: 600 });
    assert.deepEqual(PC.targetDimensions(6000, 4000, 2000), { width: 2000, height: 1333 });
    assert.equal(PC.targetDimensions(0, 0, 2000), null);
});

test('formats byte counts', () => {
    assert.equal(PC.formatBytes(0), '0 B');
    assert.equal(PC.formatBytes(1536), '1.5 KB');
    assert.equal(PC.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('reads PNG dimensions from the header', () => {
    const buffer = new ArrayBuffer(24);
    const view = new DataView(buffer);
    view.setUint8(0, 0x89);
    view.setUint32(1, 0x504e47);
    view.setUint32(16, 4032);
    view.setUint32(20, 3024);
    assert.deepEqual(PC.readImageSize(buffer), { width: 4032, height: 3024 });
});

test('reads JPEG dimensions from SOF0', () => {
    const bytes = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08,
        0x02, 0x58,
        0x03, 0x20,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
    ]);
    assert.deepEqual(PC.readImageSize(bytes.buffer), { width: 800, height: 600 });
});

test('reads EXIF orientation from a JPEG APP1 block', () => {
    const bytes = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe1, 0x00, 0x22,
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]);
    assert.equal(PC.readOrientation(bytes.buffer), 6);
    assert.equal(PC.readOrientation(new ArrayBuffer(32)), 1);
});

test('reads WebP VP8X dimensions', () => {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x52494646);
    view.setUint32(8, 0x57454250);
    view.setUint8(12, 0x56);
    view.setUint8(13, 0x50);
    view.setUint8(14, 0x38);
    view.setUint8(15, 0x58);
    const width = 1920 - 1;
    const height = 1080 - 1;
    view.setUint8(24, width & 0xff);
    view.setUint8(25, (width >> 8) & 0xff);
    view.setUint8(26, (width >> 16) & 0xff);
    view.setUint8(27, height & 0xff);
    view.setUint8(28, (height >> 8) & 0xff);
    view.setUint8(29, (height >> 16) & 0xff);
    assert.deepEqual(PC.readImageSize(bytes.buffer), { width: 1920, height: 1080 });
});

test('returns null for unknown data', () => {
    assert.equal(PC.readImageSize(new ArrayBuffer(32)), null);
});
