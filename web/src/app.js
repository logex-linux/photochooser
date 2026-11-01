/**
 * Photochooser web app controller.
 *
 * Performance rules:
 *  - never decode on the UI thread (two workers: preview + thumbnails)
 *  - decode at display size, not full resolution
 *  - keep a small LRU of decoded bitmaps and prefetch neighbours
 *  - draw to a single canvas instead of swapping <img> elements
 */
(function () {
    'use strict';

    const PC = window.PC;
    const PCSource = window.PCSource;

    const PREVIEW_MAX = 2400;
    const THUMB_MAX = 200;
    const CACHE_LIMIT = 6;
    const PREFETCH_OFFSETS = [1, 2, -1];
    const VERSION = '1.0.0';

    const el = {
        stage: document.getElementById('stage'),
        empty: document.getElementById('empty'),
        emptyCard: document.querySelector('.empty-card'),
        viewer: document.getElementById('viewer'),
        canvas: document.getElementById('preview'),
        photoName: document.getElementById('photoName'),
        photoMeta: document.getElementById('photoMeta'),
        rejectedFlag: document.getElementById('rejectedFlag'),
        loading: document.getElementById('loading'),
        filmstrip: document.getElementById('filmstrip'),
        folderChip: document.getElementById('folderChip'),
        folderName: document.getElementById('folderName'),
        sourceKind: document.getElementById('sourceKind'),
        stats: document.getElementById('stats'),
        statReviewed: document.getElementById('statReviewed'),
        statKept: document.getElementById('statKept'),
        statRejected: document.getElementById('statRejected'),
        progress: document.getElementById('progress'),
        openBtn: document.getElementById('openBtn'),
        emptyOpen: document.getElementById('emptyOpen'),
        applyBtn: document.getElementById('applyBtn'),
        prevBtn: document.getElementById('prevBtn'),
        nextBtn: document.getElementById('nextBtn'),
        keepBtn: document.getElementById('keepBtn'),
        rejectBtn: document.getElementById('rejectBtn'),
        undoBtn: document.getElementById('undoBtn'),
        helpBtn: document.getElementById('helpBtn'),
        helpDialog: document.getElementById('helpDialog'),
        controls: document.getElementById('controls'),
        helpNote: document.getElementById('helpNote'),
        modeBadge: document.getElementById('modeBadge'),
        toast: document.getElementById('toast')
    };

    const state = {
        source: null,
        entries: [],
        byId: new Map(),
        index: 0,
        generation: 0,
        cache: new Map(),
        history: [],
        thumbUrls: new Map(),
        prefetching: new Set(),
        busy: false,
        observer: null,
        currentBitmap: null
    };

    // ---------------------------------------------------------------- workers

    function workerURL() {
        const tag = document.getElementById('pc-worker-source');
        if (tag && tag.textContent && tag.textContent.trim()) {
            return URL.createObjectURL(new Blob([tag.textContent], { type: 'text/javascript' }));
        }
        return 'worker.js';
    }

    const workerUrl = workerURL();
    const previewWorker = new Worker(workerUrl);
    const thumbWorker = new Worker(workerUrl);

    let requestId = 0;
    const pending = new Map();

    function onWorkerMessage(event) {
        const data = event.data || {};
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id);
        if (data.ok) waiter.resolve(data.bitmap || data.blob);
        else waiter.reject(new Error(data.error || '解码失败'));
    }

    previewWorker.onmessage = onWorkerMessage;
    thumbWorker.onmessage = onWorkerMessage;

    function request(worker, payload, priority) {
        return new Promise(function (resolve, reject) {
            const id = ++requestId;
            pending.set(id, { resolve: resolve, reject: reject });
            worker.postMessage(Object.assign({ id: id, priority: priority || 0 }, payload));
        });
    }

    // ------------------------------------------------------------------ cache

    function currentEntry() {
        return state.entries[state.index] || null;
    }

    function cachePut(id, bitmap) {
        const existing = state.cache.get(id);
        if (existing && existing !== bitmap) existing.close();
        state.cache.set(id, bitmap);

        while (state.cache.size > CACHE_LIMIT) {
            const activeId = currentEntry() ? currentEntry().id : null;
            let victim = null;
            for (const key of state.cache.keys()) {
                if (key !== activeId) {
                    victim = key;
                    break;
                }
            }
            if (victim === null) break;
            state.cache.get(victim).close();
            state.cache.delete(victim);
        }
    }

    function clearCache() {
        state.cache.forEach(function (bitmap) {
            bitmap.close();
        });
        state.cache.clear();
        state.currentBitmap = null;
    }

    // ---------------------------------------------------------------- drawing

    function canvasContext() {
        return el.canvas.getContext('2d', { alpha: false });
    }

    function resizeCanvas() {
        const rect = el.stage.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (el.canvas.width !== width || el.canvas.height !== height) {
            el.canvas.width = width;
            el.canvas.height = height;
        }
        return { dpr: dpr, width: width, height: height };
    }

    function drawBitmap(bitmap) {
        if (!bitmap) return;
        state.currentBitmap = bitmap;
        const size = resizeCanvas();
        const context = canvasContext();
        const pad = Math.round(26 * size.dpr);
        const availableWidth = Math.max(1, size.width - pad * 2);
        const availableHeight = Math.max(1, size.height - pad * 2);
        const scale = Math.min(availableWidth / bitmap.width, availableHeight / bitmap.height);
        const drawWidth = Math.max(1, bitmap.width * scale);
        const drawHeight = Math.max(1, bitmap.height * scale);

        const x = Math.round((size.width - drawWidth) / 2);
        const y = Math.round((size.height - drawHeight) / 2);

        context.fillStyle = '#080a0e';
        context.fillRect(0, 0, size.width, size.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';

        // A soft shadow lifts the photo off the background without extra DOM.
        context.save();
        context.shadowColor = 'rgba(0, 0, 0, 0.55)';
        context.shadowBlur = 32 * size.dpr;
        context.shadowOffsetY = 12 * size.dpr;
        context.drawImage(bitmap, x, y, Math.round(drawWidth), Math.round(drawHeight));
        context.restore();
    }

    let resizeFrame = 0;
    window.addEventListener('resize', function () {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(function () {
            resizeFrame = 0;
            if (state.currentBitmap) drawBitmap(state.currentBitmap);
        });
    });

    // ----------------------------------------------------------------- chrome

    let loadingTimer = 0;

    function showLoadingSoon(generation) {
        clearTimeout(loadingTimer);
        el.loading.hidden = true;
        loadingTimer = setTimeout(function () {
            if (generation === state.generation) el.loading.hidden = false;
        }, 140);
    }

    function hideLoading() {
        clearTimeout(loadingTimer);
        el.loading.hidden = true;
    }

    function updateStats() {
        let reviewed = 0;
        let kept = 0;
        let rejected = 0;
        for (const entry of state.entries) {
            if (entry.rejected) {
                rejected += 1;
                reviewed += 1;
            } else if (entry.kept) {
                kept += 1;
                reviewed += 1;
            }
        }
        el.statReviewed.textContent = String(reviewed);
        el.statKept.textContent = String(kept);
        el.statRejected.textContent = String(rejected);
        el.applyBtn.textContent = rejected ? '应用删除 · ' + rejected : '应用删除';
        el.applyBtn.hidden = rejected === 0;
        el.progress.textContent = PC.formatProgress(state.index, state.entries.length);
        el.undoBtn.disabled = state.history.length === 0;
    }

    function updateFolderChrome() {
        const source = state.source;
        if (!source) return;
        el.folderChip.hidden = false;
        el.folderName.textContent = source.folderName || '未命名文件夹';
        el.sourceKind.textContent = PCSource.describe(source);
        el.stats.hidden = false;
        el.filmstrip.hidden = state.entries.length === 0;
        el.controls.hidden = state.entries.length === 0;
        el.empty.hidden = true;
        el.viewer.hidden = state.entries.length === 0;
    }

    function updateCurrentChrome() {
        const entry = currentEntry();
        el.prevBtn.disabled = state.index <= 0;
        el.nextBtn.disabled = state.index >= state.entries.length - 1;
        el.keepBtn.disabled = !entry;
        el.rejectBtn.disabled = !entry;
        el.rejectedFlag.hidden = !entry || !entry.rejected;
        if (entry) {
            el.photoName.textContent = entry.name;
        }
        el.progress.textContent = PC.formatProgress(state.index, state.entries.length);
        updateStats();
        highlightCurrentThumb();
    }

    function setBusy(busy) {
        state.busy = busy;
        el.openBtn.disabled = busy;
        el.emptyOpen.disabled = busy;
        el.openBtn.textContent = busy ? '读取中…' : '打开文件夹';
    }

    let toastTimer = 0;

    function toast(message, tone) {
        el.toast.textContent = message;
        el.toast.className = 'toast show' + (tone === 'bad' ? ' bad' : '');
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.className = 'toast';
            setTimeout(function () { el.toast.hidden = true; }, 200);
        }, 2600);
    }

    function showError(error) {
        const message = String((error && error.message) || error || '未知错误');
        toast(message, 'bad');
        console.error(error);
    }

    // ------------------------------------------------------------ photo display

    async function showIndex(index) {
        if (!state.entries.length) return;
        const next = PC.clampIndex(index, state.entries.length);
        const entry = state.entries[next];

        state.index = next;
        state.generation += 1;
        const generation = state.generation;

        updateCurrentChrome();
        el.rejectedFlag.hidden = !entry.rejected;
        el.photoName.textContent = entry.name;
        el.photoMeta.textContent = '';

        const cached = state.cache.get(entry.id);
        if (cached) {
            drawBitmap(cached);
            hideLoading();
            schedulePrefetch();
            return;
        }

        showLoadingSoon(generation);
        try {
            const blob = await PCSource.blobFor(entry);
            const bitmap = await request(
                previewWorker,
                { kind: 'preview', blob: blob, maxPixel: PREVIEW_MAX },
                0
            );
            if (generation !== state.generation) {
                bitmap.close();
                return;
            }
            cachePut(entry.id, bitmap);
            drawBitmap(bitmap);
            el.photoMeta.textContent =
                bitmap.width + ' × ' + bitmap.height + ' · ' + PC.formatBytes(blob.size);
            schedulePrefetch();
        } catch (error) {
            if (generation === state.generation) showError(error);
        } finally {
            if (generation === state.generation) hideLoading();
        }
    }

    async function schedulePrefetch() {
        for (const offset of PREFETCH_OFFSETS) {
            const index = state.index + offset;
            const entry = state.entries[index];
            if (!entry || state.cache.has(entry.id) || state.prefetching.has(entry.id)) continue;

            state.prefetching.add(entry.id);
            try {
                const blob = await PCSource.blobFor(entry);
                const bitmap = await request(
                    previewWorker,
                    { kind: 'preview', blob: blob, maxPixel: PREVIEW_MAX },
                    20
                );
                if (!state.byId.has(entry.id) || state.cache.has(entry.id)) {
                    bitmap.close();
                    continue;
                }
                cachePut(entry.id, bitmap);
            } catch (error) {
                // Prefetching is best effort.
            } finally {
                state.prefetching.delete(entry.id);
            }
        }
    }

    // ------------------------------------------------------------- filmstrip

    function ensureObserver() {
        if (state.observer) state.observer.disconnect();
        state.observer = new IntersectionObserver(function (entries) {
            for (const record of entries) {
                if (record.isIntersecting) {
                    state.observer.unobserve(record.target);
                    loadThumb(record.target);
                }
            }
        }, { root: el.filmstrip, rootMargin: '320px' });
    }

    function renderFilmstrip() {
        el.filmstrip.innerHTML = '';
        state.thumbUrls.forEach(function (url) { URL.revokeObjectURL(url); });
        state.thumbUrls.clear();
        state.byId = new Map();
        ensureObserver();

        const fragment = document.createDocumentFragment();
        state.entries.forEach(function (entry, index) {
            state.byId.set(entry.id, entry);

            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'thumb';
            cell.dataset.id = entry.id;
            cell.title = entry.name;
            cell.setAttribute('aria-label', '第 ' + (index + 1) + ' 张：' + entry.name);
            if (entry.rejected) cell.classList.add('is-rejected');

            const number = document.createElement('span');
            number.className = 'thumb-index';
            number.textContent = String(index + 1);
            cell.appendChild(number);

            const badge = document.createElement('span');
            badge.className = 'thumb-badge';
            badge.textContent = '删';
            cell.appendChild(badge);

            cell.addEventListener('click', function () {
                showIndex(index);
            });

            fragment.appendChild(cell);
            state.observer.observe(cell);
        });

        el.filmstrip.appendChild(fragment);
        el.filmstrip.hidden = state.entries.length === 0;
        highlightCurrentThumb();
    }

    async function loadThumb(cell) {
        if (cell.dataset.loaded === '1') return;
        cell.dataset.loaded = '1';
        const entry = state.byId.get(cell.dataset.id);
        if (!entry) return;

        try {
            const blob = await PCSource.blobFor(entry);
            const thumb = await request(
                thumbWorker,
                { kind: 'thumb', blob: blob, maxPixel: THUMB_MAX, quality: 0.82 },
                30
            );
            if (!cell.isConnected) return;
            const url = URL.createObjectURL(thumb);
            state.thumbUrls.set(entry.id, url);
            const image = new Image();
            image.alt = '';
            image.decoding = 'async';
            image.src = url;
            cell.prepend(image);
        } catch (error) {
            cell.classList.add('is-broken');
        }
    }

    function highlightCurrentThumb() {
        const previous = el.filmstrip.querySelector('.thumb.is-current');
        if (previous) previous.classList.remove('is-current');
        const entry = currentEntry();
        if (!entry) return;
        const cell = el.filmstrip.querySelector('.thumb[data-id="' + cssEscape(entry.id) + '"]');
        if (!cell) return;
        cell.classList.add('is-current');
        cell.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    // --------------------------------------------------------------- sources

    function loadSource(source) {
        clearCache();
        state.source = source;
        state.entries = source.entries.slice();
        state.index = 0;
        state.history = [];
        state.generation += 1;
        state.prefetching.clear();
        state.byId = new Map();

        updateFolderChrome();
        renderFilmstrip();

        if (!state.entries.length) {
            el.viewer.hidden = true;
            el.empty.hidden = false;
            el.filmstrip.hidden = true;
            el.stats.hidden = true;
            el.controls.hidden = true;
            el.progress.textContent = '0 张';
            toast(source.skipped ? '没有可预览的照片（已跳过 ' + source.skipped + ' 张 HEIC/HIF）' : '这个文件夹里没有可预览的照片', 'bad');
            return;
        }

        el.empty.hidden = true;
        el.viewer.hidden = false;
        updateCurrentChrome();
        showIndex(0);

        if (source.skipped) {
            toast('已跳过 ' + source.skipped + ' 张 HEIC/HIF，请用 macOS 版查看');
        }
    }

    // --------------------------------------------------------------- actions

    function mark(entry, changes) {
        state.history.push({
            index: state.index,
            id: entry.id,
            rejected: entry.rejected,
            kept: entry.kept
        });
        entry.rejected = !!changes.rejected;
        entry.kept = !!changes.kept;
        syncThumbState(entry);
        updateStats();
    }

    function syncThumbState(entry) {
        const cell = el.filmstrip.querySelector('.thumb[data-id="' + cssEscape(entry.id) + '"]');
        if (!cell) return;
        cell.classList.toggle('is-rejected', !!entry.rejected);
    }

    function advance(delta) {
        const next = state.index + delta;
        if (next < 0) return;
        if (next >= state.entries.length) {
            toast('已经到最后一张了');
            return;
        }
        showIndex(next);
    }

    function keepCurrent() {
        const entry = currentEntry();
        if (!entry) return;
        mark(entry, { rejected: false, kept: true });
        advance(1);
    }

    function rejectCurrent() {
        const entry = currentEntry();
        if (!entry) return;
        mark(entry, { rejected: true, kept: false });
        advance(1);
    }

    function undo() {
        const last = state.history.pop();
        if (!last) {
            toast('没有可撤销的操作');
            return;
        }
        const entry = state.byId.get(last.id);
        if (!entry) {
            updateStats();
            return;
        }
        entry.rejected = last.rejected;
        entry.kept = last.kept;
        syncThumbState(entry);
        showIndex(last.index);
        toast('已撤销');
    }

    async function applyDeletes() {
        const rejected = state.entries.filter(function (entry) { return entry.rejected; });
        if (!rejected.length) {
            toast('还没有标记删除的照片');
            return;
        }
        if (!state.source || !state.source.canDelete) {
            toast('当前打开方式不支持删除，请用桌面版或 Chrome/Edge 选文件夹', 'bad');
            return;
        }

        const message = state.source.canRestore
            ? '把 ' + rejected.length + ' 张照片移到系统回收站？'
            : '永久删除 ' + rejected.length + ' 张照片（无法恢复），确定吗？';
        if (!window.confirm(message)) return;

        setBusy(true);
        try {
            const result = await PCSource.removeEntries(state.source, rejected);
            const removedIds = new Set(result.removed.map(function (entry) { return entry.id; }));

            state.entries = state.entries.filter(function (entry) {
                return !removedIds.has(entry.id);
            });
            state.history = [];
            removedIds.forEach(function (id) {
                const bitmap = state.cache.get(id);
                if (bitmap) {
                    bitmap.close();
                    state.cache.delete(id);
                }
            });

            renderFilmstrip();
            updateStats();

            if (!state.entries.length) {
                el.viewer.hidden = true;
                el.empty.hidden = false;
                el.filmstrip.hidden = true;
                el.controls.hidden = true;
                el.progress.textContent = '0 张';
                toast('全部处理完成');
            } else {
                showIndex(Math.min(state.index, state.entries.length - 1));
                toast(
                    result.failed
                        ? '已删除 ' + result.removed.length + ' 张，' + result.failed + ' 张失败'
                        : '已删除 ' + result.removed.length + ' 张',
                    result.failed ? 'bad' : ''
                );
            }
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    }

    // ----------------------------------------------------------------- events

    function openFolder() {
        if (state.busy) return;
        setBusy(true);
        PCSource.pickFolder()
            .then(function (source) {
                if (source) loadSource(source);
            })
            .catch(showError)
            .finally(function () { setBusy(false); });
    }

    el.openBtn.addEventListener('click', openFolder);
    el.emptyOpen.addEventListener('click', openFolder);
    el.prevBtn.addEventListener('click', function () { advance(-1); });
    el.nextBtn.addEventListener('click', function () { advance(1); });
    el.keepBtn.addEventListener('click', keepCurrent);
    el.rejectBtn.addEventListener('click', rejectCurrent);
    el.undoBtn.addEventListener('click', undo);
    el.applyBtn.addEventListener('click', applyDeletes);
    el.helpBtn.addEventListener('click', function () { el.helpDialog.showModal(); });

    document.addEventListener('keydown', function (event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (el.helpDialog.open) return;
        if (event.target && /input|textarea|select/i.test(event.target.tagName)) return;

        switch (event.key) {
            case '1':
                event.preventDefault();
                keepCurrent();
                break;
            case '2':
                event.preventDefault();
                rejectCurrent();
                break;
            case '3':
                event.preventDefault();
                undo();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                advance(-1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                advance(1);
                break;
            default:
                break;
        }
    });

    // Drag & drop a folder or a bunch of photos.
    let dragDepth = 0;

    document.addEventListener('dragenter', function (event) {
        event.preventDefault();
        dragDepth += 1;
        if (!state.busy) el.emptyCard.classList.add('dragover');
    });

    document.addEventListener('dragover', function (event) {
        event.preventDefault();
    });

    document.addEventListener('dragleave', function (event) {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) el.emptyCard.classList.remove('dragover');
    });

    document.addEventListener('drop', function (event) {
        event.preventDefault();
        dragDepth = 0;
        el.emptyCard.classList.remove('dragover');
        if (state.busy) return;

        const transfer = event.dataTransfer;
        if (!transfer) return;

        const item = transfer.items && transfer.items[0];
        const dirEntry = item && typeof item.webkitGetAsEntry === 'function'
            ? item.webkitGetAsEntry()
            : null;

        if (dirEntry && dirEntry.isDirectory) {
            PCSource.entriesFromDirectoryEntry(dirEntry)
                .then(function (source) {
                    if (source && source.entries.length) loadSource(source);
                    else toast('这个文件夹里没有可预览的照片', 'bad');
                })
                .catch(showError);
            return;
        }

        const files = Array.prototype.slice.call(transfer.files || []);
        if (!files.length) return;
        const source = PCSource.entriesFromFiles(files);
        if (source.entries.length) loadSource(source);
        else toast('没有可预览的照片', 'bad');
    });

    // ------------------------------------------------------------------- init

    function init() {
        if (PCSource.isElectron()) {
            el.modeBadge.textContent = 'Windows';
            el.helpNote.textContent = '标记完成后点右上角「应用删除」，照片会进入系统回收站。';
        } else {
            el.modeBadge.textContent = 'Web';
        }
        el.progress.textContent = '0 张';
        el.undoBtn.disabled = true;
        updateStats();
    }

    // Small public surface: lets the page be embedded or driven by tests.
    window.Photochooser = {
        version: VERSION,
        openFolder: openFolder,
        openFiles: function (files) {
            const source = PCSource.entriesFromFiles(Array.prototype.slice.call(files || []));
            if (source.entries.length) loadSource(source);
            return source.entries.length;
        },
        getState: function () {
            return {
                index: state.index,
                total: state.entries.length,
                rejected: state.entries.filter(function (entry) { return entry.rejected; }).length,
                kept: state.entries.filter(function (entry) { return entry.kept; }).length,
                name: currentEntry() ? currentEntry().name : null
            };
        }
    };

    init();
})();
