'use strict';

const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'photochooser';
const APP_ORIGIN = APP_SCHEME + '://local';
const WEB_DIR = path.join(__dirname, 'web');
const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp']);
const DESKTOP_ONLY = new Set(['heic', 'heif', 'hif']);

// Folders the renderer is allowed to read photos from.
const allowedRoots = new Set();

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true
        }
    }
]);

let mainWindow = null;

function isAllowedPhoto(target) {
    const resolved = path.resolve(target);
    const extension = path.extname(resolved).slice(1).toLowerCase();
    if (!PHOTO_EXTENSIONS.has(extension)) return false;

    for (const root of allowedRoots) {
        if (resolved === root || resolved.startsWith(root + path.sep)) return true;
    }
    return false;
}

function registerProtocol() {
    protocol.handle(APP_SCHEME, async function (request) {
        const url = new URL(request.url);

        if (url.pathname === '/photo') {
            const target = url.searchParams.get('p');
            if (!target || !isAllowedPhoto(target)) {
                return new Response('forbidden', { status: 403 });
            }
            return net.fetch(pathToFileURL(target).toString());
        }

        const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const filePath = path.join(WEB_DIR, relative);
        if (!filePath.startsWith(WEB_DIR + path.sep)) {
            return new Response('forbidden', { status: 403 });
        }
        return net.fetch(pathToFileURL(filePath).toString());
    });
}

async function readFolder(folderPath) {
    allowedRoots.add(path.resolve(folderPath));

    const dirents = await fs.readdir(folderPath, { withFileTypes: true });
    const entries = [];
    let skipped = 0;

    for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        const extension = path.extname(dirent.name).slice(1).toLowerCase();
        if (!PHOTO_EXTENSIONS.has(extension)) {
            if (DESKTOP_ONLY.has(extension)) skipped += 1;
            continue;
        }
        const fullPath = path.join(folderPath, dirent.name);
        entries.push({
            name: dirent.name,
            path: fullPath,
            url: APP_ORIGIN + '/photo?p=' + encodeURIComponent(fullPath)
        });
    }

    entries.sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return {
        name: path.basename(folderPath),
        path: folderPath,
        entries: entries,
        skipped: skipped
    };
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#080a0e',
        title: 'Photochooser',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            devTools: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(function () {
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', function (event) {
        event.preventDefault();
    });

    mainWindow.loadURL(APP_ORIGIN + '/index.html');
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function registerIpc() {
    ipcMain.handle('pc:pick-folder', async function () {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择照片文件夹',
            properties: ['openDirectory']
        });
        if (result.canceled || !result.filePaths.length) return null;
        return readFolder(result.filePaths[0]);
    });

    ipcMain.handle('pc:trash', async function (event, paths) {
        const trashed = [];
        let failed = 0;

        for (const target of Array.isArray(paths) ? paths : []) {
            try {
                if (!isAllowedPhoto(target)) throw new Error('path not allowed');
                await shell.trashItem(target);
                trashed.push(target);
            } catch (error) {
                console.warn('trash failed', target, error);
                failed += 1;
            }
        }
        return { trashed: trashed, failed: failed };
    });

    ipcMain.handle('pc:reveal', async function (event, target) {
        if (isAllowedPhoto(target)) shell.showItemInFolder(target);
    });
}

app.setAppUserModelId('local.linnx.Photochooser');

app.whenReady().then(function () {
    registerProtocol();
    registerIpc();
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
