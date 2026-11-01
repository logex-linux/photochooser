#!/usr/bin/env node
/**
 * Stamps the Photochooser icon and version info onto the packaged Windows exe.
 * Pure JavaScript (no Wine), so it works when cross-building on macOS/Linux.
 *
 * Usage: node desktop/set-icon.mjs path/to/Photochooser.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) {
    console.error('usage: node set-icon.mjs <exe>');
    process.exit(1);
}

const iconPath = path.join(here, 'assets', 'icon.ico');
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

const exe = NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
const resources = NtExecutableResource.from(exe);

const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    1033,
    iconFile.icons.map((icon) => icon.data)
);

// Replace the Electron version block with product information.
const versionEntries = Resource.VersionInfo.fromEntries(resources.entries);
if (versionEntries.length) {
    const info = versionEntries[0];
    info.setStringValues(
        { lang: 1033, codepage: 1200 },
        {
            ProductName: 'Photochooser',
            FileDescription: 'Photochooser — 快速筛照片',
            CompanyName: 'Photochooser contributors',
            LegalCopyright: 'MIT License',
            InternalName: 'Photochooser',
            OriginalFilename: 'Photochooser.exe',
            ProductVersion: version,
            FileVersion: version
        }
    );
    info.setFileVersion(version);
    info.setProductVersion(version);
    info.outputToResourceEntries(resources.entries);
}

resources.outputResource(exe);
fs.writeFileSync(target, Buffer.from(exe.generate()));
console.log('icon + version written to', target);
