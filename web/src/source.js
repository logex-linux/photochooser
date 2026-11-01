/**
 * Folder access adapters.
 *
 * Three environments are supported, in order of preference:
 *  1. Electron (Windows build)  – native folder dialog, files served over pcfile://, real Recycle Bin deletes.
 *  2. Chromium File System Access API – read/write handles, real deletion.
 *  3. <input webkitdirectory> – read-only fallback for Safari/Firefox and file:// pages.
 */
(function (root) {
    'use strict';

    const PC = root.PC;

    function bridge() {
        return root.photochooser || null;
    }

    function isElectron() {
        const api = bridge();
        return !!(api && typeof api.pickFolder === 'function');
    }

    async function pickFolder() {
        if (isElectron()) return pickElectron();

        if (typeof root.showDirectoryPicker === 'function') {
            try {
                return await pickWithHandle();
            } catch (error) {
                if (error && error.name === 'AbortError') return null;
                // file:// pages and unsupported contexts land here.
                console.warn('File System Access unavailable, falling back:', error);
            }
        }
        return pickWithInput();
    }

    async function pickElectron() {
        const result = await bridge().pickFolder();
        if (!result || !result.entries) return null;

        const entries = result.entries.map(function (item) {
            return {
                id: item.path,
                name: item.name,
                path: item.path,
                url: item.url
            };
        });

        return {
            kind: 'electron',
            folderName: result.name,
            folderPath: result.path,
            canDelete: true,
            canRestore: true,
            entries: entries,
            skipped: 0
        };
    }

    async function pickWithHandle() {
        const dirHandle = await root.showDirectoryPicker({ id: 'photochooser', mode: 'readwrite' });
        const entries = [];
        let skipped = 0;

        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind !== 'file') continue;
            if (!PC.isBrowserPhoto(name)) {
                if (PC.isDesktopPhoto(name)) skipped += 1;
                continue;
            }
            entries.push({ id: name, name: name, handle: handle });
        }

        entries.sort(function (a, b) { return PC.compareNames(a.name, b.name); });

        return {
            kind: 'handle',
            folderName: dirHandle.name,
            dirHandle: dirHandle,
            canDelete: true,
            canRestore: false,
            entries: entries,
            skipped: skipped
        };
    }

    function pickWithInput() {
        return new Promise(function (resolve) {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.webkitdirectory = true;
            input.style.display = 'none';
            document.body.appendChild(input);

            let settled = false;
            function finish(value) {
                if (settled) return;
                settled = true;
                input.remove();
                resolve(value);
            }

            input.addEventListener('change', function () {
                const files = Array.prototype.slice.call(input.files || []);
                finish(entriesFromFiles(files));
            });
            input.addEventListener('cancel', function () { finish(null); });
            input.click();
        });
    }

    function entriesFromFiles(files) {
        const entries = [];
        let skipped = 0;
        let folderName = null;

        for (const file of files) {
            const relative = file.webkitRelativePath || file.name;
            const parts = relative.split('/');
            if (parts.length > 1) folderName = folderName || parts[0];
            if (parts.length > 2) continue; // only the top level, like the desktop app

            const name = file.name;
            if (!PC.isBrowserPhoto(name)) {
                if (PC.isDesktopPhoto(name)) skipped += 1;
                continue;
            }
            entries.push({
                id: relative + '#' + entries.length,
                name: name,
                file: file,
                size: file.size
            });
        }

        entries.sort(function (a, b) { return PC.compareNames(a.name, b.name); });

        return {
            kind: 'files',
            folderName: folderName || '已选择文件夹',
            canDelete: false,
            canRestore: false,
            entries: entries,
            skipped: skipped
        };
    }

    async function entriesFromDirectoryEntry(dirEntry) {
        const files = [];
        const reader = dirEntry.createReader();

        function readBatch() {
            return new Promise(function (resolve, reject) {
                reader.readEntries(resolve, reject);
            });
        }

        while (true) {
            const batch = await readBatch();
            if (!batch.length) break;
            for (const item of batch) {
                if (item.isFile) {
                    const file = await new Promise(function (resolve, reject) {
                        item.file(resolve, reject);
                    });
                    files.push(file);
                }
            }
        }

        const result = entriesFromFiles(files);
        result.folderName = dirEntry.name || result.folderName;
        return result;
    }

    function blobFor(entry) {
        if (entry.file) return Promise.resolve(entry.file);
        if (entry.handle) return entry.handle.getFile();
        if (entry.url) {
            return fetch(entry.url).then(function (response) {
                if (!response.ok) throw new Error('读取失败：' + response.status);
                return response.blob();
            });
        }
        return Promise.reject(new Error('无法读取该照片'));
    }

    async function removeEntries(source, entries) {
        if (source.kind === 'electron') {
            const result = await bridge().trash(entries.map(function (entry) { return entry.path; }));
            const trashed = new Set(result.trashed || []);
            return {
                removed: entries.filter(function (entry) { return trashed.has(entry.path); }),
                failed: result.failed || 0
            };
        }

        if (source.kind === 'handle') {
            const removed = [];
            let failed = 0;
            for (const entry of entries) {
                try {
                    if (entry.handle && typeof entry.handle.remove === 'function') {
                        await entry.handle.remove();
                    } else {
                        await source.dirHandle.removeEntry(entry.name);
                    }
                    removed.push(entry);
                } catch (error) {
                    console.warn('remove failed', entry.name, error);
                    failed += 1;
                }
            }
            return { removed: removed, failed: failed };
        }

        throw new Error('当前打开方式不支持删除');
    }

    function describe(source) {
        if (!source) return '';
        if (source.kind === 'electron') return '桌面版 · 删除到回收站';
        if (source.kind === 'handle') return '浏览器版 · 可直接删除文件';
        return '浏览器版 · 只读模式';
    }

    root.PCSource = {
        isElectron: isElectron,
        pickFolder: pickFolder,
        entriesFromFiles: entriesFromFiles,
        entriesFromDirectoryEntry: entriesFromDirectoryEntry,
        blobFor: blobFor,
        removeEntries: removeEntries,
        describe: describe
    };
})(window);
