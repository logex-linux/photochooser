/**
 * Pure helpers shared by the web app, the worker and the unit tests.
 * No DOM access here.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.PC = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DESKTOP_EXTENSIONS = ['hif', 'heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'];
    const BROWSER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'];

    function extensionOf(name) {
        const dot = String(name).lastIndexOf('.');
        return dot === -1 ? '' : String(name).slice(dot + 1).toLowerCase();
    }

    function isDesktopPhoto(name) {
        return DESKTOP_EXTENSIONS.indexOf(extensionOf(name)) !== -1;
    }

    function isBrowserPhoto(name) {
        return BROWSER_EXTENSIONS.indexOf(extensionOf(name)) !== -1;
    }

    /** Finder-like ordering: IMG_2 before IMG_10. */
    function compareNames(a, b) {
        return String(a).localeCompare(String(b), undefined, {
            numeric: true,
            sensitivity: 'base'
        });
    }

    function sortByName(names) {
        return names.slice().sort(compareNames);
    }

    function clampIndex(index, length) {
        if (length <= 0) return 0;
        return Math.min(Math.max(index, 0), length - 1);
    }

    function formatProgress(index, total) {
        if (!total) return '0 张';
        return (clampIndex(index, total) + 1) + ' / ' + total;
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = value >= 10 || unit === 0 ? 0 : 1;
        return value.toFixed(digits) + ' ' + units[unit];
    }

    /** Size the decoded bitmap should have, never upscaling. */
    function targetDimensions(width, height, maxPixel) {
        if (!width || !height) return null;
        const longest = Math.max(width, height);
        if (longest <= maxPixel) return { width, height };
        const scale = maxPixel / longest;
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
        };
    }

    /**
     * Reads the EXIF orientation (1-8) from a JPEG header.
     * Anything else, or any parse problem, is treated as upright.
     */
    function readOrientation(buffer) {
        if (!buffer || buffer.byteLength < 16) return 1;
        const view = new DataView(buffer);
        if (view.getUint16(0, false) !== 0xffd8) return 1;

        let offset = 2;
        while (offset + 4 < view.byteLength) {
            if (view.getUint8(offset) !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = view.getUint8(offset + 1);
            if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = view.getUint16(offset + 2, false);
            if (marker === 0xe1) {
                const start = offset + 4;
                if (start + 6 > view.byteLength) return 1;
                if (view.getUint32(start, false) !== 0x45786966) return 1; // "Exif"

                const tiff = start + 6;
                if (tiff + 8 > view.byteLength) return 1;
                const little = view.getUint16(tiff, false) === 0x4949;
                const ifd = tiff + view.getUint32(tiff + 4, little);
                if (ifd + 2 > view.byteLength) return 1;

                const count = view.getUint16(ifd, little);
                for (let i = 0; i < count; i += 1) {
                    const entry = ifd + 2 + i * 12;
                    if (entry + 12 > view.byteLength) return 1;
                    if (view.getUint16(entry, little) === 0x0112) {
                        const value = view.getUint16(entry + 8, little);
                        return value >= 1 && value <= 8 ? value : 1;
                    }
                }
                return 1;
            }
            if (length < 2) return 1;
            offset += 2 + length;
        }
        return 1;
    }

    /**
     * Reads image dimensions from the file header so the worker can ask the
     * decoder for an exactly sized bitmap instead of decoding full resolution.
     */
    function readImageSize(buffer) {
        if (!buffer || buffer.byteLength < 24) return null;
        const view = new DataView(buffer);

        // JPEG
        if (view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8) {
            let offset = 2;
            while (offset + 9 < view.byteLength) {
                if (view.getUint8(offset) !== 0xff) {
                    offset += 1;
                    continue;
                }
                const marker = view.getUint8(offset + 1);
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    offset += 2;
                    continue;
                }
                const length = view.getUint16(offset + 2, false);
                const isSOF = marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
                if (isSOF) {
                    return {
                        height: view.getUint16(offset + 5, false),
                        width: view.getUint16(offset + 7, false)
                    };
                }
                if (length < 2) return null;
                offset += 2 + length;
            }
            return null;
        }

        // PNG
        if (view.getUint8(0) === 0x89 && view.getUint32(1) === 0x504e47) {
            return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
        }

        // GIF
        if (view.getUint32(0) === 0x47494638) {
            return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        }

        // WebP
        if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
            const chunk = String.fromCharCode(
                view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15)
            );
            if (chunk === 'VP8 ') {
                return {
                    width: view.getUint16(26, true) & 0x3fff,
                    height: view.getUint16(28, true) & 0x3fff
                };
            }
            if (chunk === 'VP8L') {
                const b1 = view.getUint8(21);
                const b2 = view.getUint8(22);
                const b3 = view.getUint8(23);
                const b4 = view.getUint8(24);
                return {
                    width: 1 + (((b2 & 0x3f) << 8) | b1),
                    height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6))
                };
            }
            if (chunk === 'VP8X') {
                return {
                    width: 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)),
                    height: 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16))
                };
            }
            return null;
        }

        // BMP
        if (view.getUint8(0) === 0x42 && view.getUint8(1) === 0x4d) {
            return {
                width: Math.abs(view.getInt32(18, true)),
                height: Math.abs(view.getInt32(22, true))
            };
        }

        // AVIF / HEIF: locate the first "ispe" box.
        const bytes = new Uint8Array(buffer);
        for (let i = 4; i + 16 < bytes.length; i += 1) {
            if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
                return {
                    width: view.getUint32(i + 8, false),
                    height: view.getUint32(i + 12, false)
                };
            }
        }
        return null;
    }

    return {
        DESKTOP_EXTENSIONS,
        BROWSER_EXTENSIONS,
        extensionOf,
        isDesktopPhoto,
        isBrowserPhoto,
        compareNames,
        sortByName,
        clampIndex,
        formatProgress,
        formatBytes,
        targetDimensions,
        readImageSize,
        readOrientation
    };
});
