/**
 * Decode worker: turns a File/Blob into a right-sized bitmap or a small WebP
 * thumbnail, so the UI thread never touches full-resolution pixels.
 */
/* global PC */
if (typeof PC === 'undefined' && typeof importScripts === 'function') {
    try {
        importScripts('core.js');
    } catch (error) {
        // In the single-file build core.js is already inlined above.
    }
}

const queue = [];
let pumping = false;
let cancelled = new Set();

self.onmessage = function (event) {
    const job = event.data || {};

    if (job.type === 'cancel') {
        cancelled = new Set(job.ids || []);
        for (let i = queue.length - 1; i >= 0; i -= 1) {
            if (cancelled.has(queue[i].id)) queue.splice(i, 1);
        }
        return;
    }

    queue.push(job);
    pump();
};

async function pump() {
    if (pumping) return;
    pumping = true;

    while (queue.length) {
        // Urgent (current photo) jobs jump ahead of speculative prefetches.
        queue.sort(function (a, b) {
            return (a.priority || 0) - (b.priority || 0) || a.id - b.id;
        });
        const job = queue.shift();
        if (cancelled.has(job.id)) continue;

        try {
            const result = await run(job);
            if (cancelled.has(job.id)) {
                if (result.bitmap) result.bitmap.close();
                continue;
            }
            if (result.bitmap) {
                self.postMessage({ id: job.id, ok: true, bitmap: result.bitmap }, [result.bitmap]);
            } else {
                self.postMessage({ id: job.id, ok: true, blob: result.blob });
            }
        } catch (error) {
            self.postMessage({
                id: job.id,
                ok: false,
                error: String((error && error.message) || error)
            });
        }
    }

    pumping = false;
}

async function run(job) {
    if (job.kind === 'thumb') {
        const bitmap = await decode(job.blob, job.maxPixel);
        const scale = Math.min(1, job.maxPixel / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const blob = await canvas.convertToBlob({
            type: 'image/webp',
            quality: job.quality || 0.82
        });
        return { blob: blob };
    }

    const bitmap = await decode(job.blob, job.maxPixel);
    return { bitmap: bitmap };
}

async function decode(blob, maxPixel) {
    const meta = await readMeta(blob);
    if (meta) {
        // EXIF orientations 5-8 rotate the image a quarter turn, so the stored
        // width/height are swapped relative to what the decoder returns.
        const swapped = meta.orientation >= 5 && meta.orientation <= 8;
        const width = swapped ? meta.height : meta.width;
        const height = swapped ? meta.width : meta.height;
        const target = PC.targetDimensions(width, height, maxPixel);

        if (target && (target.width !== width || target.height !== height)) {
            return createImageBitmap(blob, {
                resizeWidth: target.width,
                resizeHeight: target.height,
                resizeQuality: 'high'
            });
        }
    }
    return createImageBitmap(blob);
}

async function readMeta(blob) {
    let buffer;
    try {
        buffer = await blob.slice(0, 131072).arrayBuffer();
    } catch (error) {
        return null;
    }

    let size = PC.readImageSize(buffer);
    if (!size) {
        try {
            buffer = await blob.arrayBuffer();
            size = PC.readImageSize(buffer);
        } catch (error) {
            return null;
        }
    }
    if (!size || !size.width || !size.height) return null;

    return {
        width: size.width,
        height: size.height,
        orientation: PC.readOrientation(buffer)
    };
}
