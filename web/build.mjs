#!/usr/bin/env node
/**
 * Builds the web deliverable:
 *   dist/web/            multi-file build (used by Electron and static hosting)
 *   dist/photochooser.html   single-file build (open it and pick a folder)
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const distDir = join(here, 'dist');
const webDir = join(distDir, 'web');

const files = ['index.html', 'styles.css', 'core.js', 'source.js', 'app.js', 'worker.js'];

async function read(name) {
    return readFile(join(srcDir, name), 'utf8');
}

function escapeScript(code) {
    return code.replace(/<\/script/gi, '<\\/script');
}

function kib(text) {
    return (Buffer.byteLength(text) / 1024).toFixed(1) + ' KB';
}

const [html, css, core, source, app, worker] = await Promise.all(files.map(read));

await rm(webDir, { recursive: true, force: true });
await mkdir(webDir, { recursive: true });
for (const name of files) {
    await copyFile(join(srcDir, name), join(webDir, name));
}

// Replacer functions keep `$&`-style sequences in the source literal.
const inline = (needle, replacement) => (html) => html.replace(needle, () => replacement);

let inlineHtml = html;
inlineHtml = inline(
    '<link rel="stylesheet" href="styles.css">',
    '<style>\n' + css + '\n</style>'
)(inlineHtml);
inlineHtml = inline(
    '<script src="core.js"></script>',
    '<script>\n' + escapeScript(core) + '\n</script>'
)(inlineHtml);
inlineHtml = inline(
    '<script src="source.js"></script>',
    '<script>\n' + escapeScript(source) + '\n</script>'
)(inlineHtml);
inlineHtml = inline(
    '<script src="app.js"></script>',
    '<script>\n' + escapeScript(app) + '\n</script>'
)(inlineHtml);
inlineHtml = inline(
    '<script type="text/plain" id="pc-worker-source"></script>',
    '<script type="text/plain" id="pc-worker-source">\n' +
        escapeScript(core) +
        '\n' +
        escapeScript(worker) +
        '\n</script>'
)(inlineHtml);

if (inlineHtml.includes('src="app.js"') || inlineHtml.includes('href="styles.css"')) {
    throw new Error('inlining failed: an external reference is still present');
}

const singleFile = join(distDir, 'photochooser.html');
await writeFile(singleFile, inlineHtml);

console.log('web/            ' + kib(inlineHtml) + ' (multi-file)');
console.log('photochooser.html ' + kib(inlineHtml) + ' (single file)');
console.log('built:', singleFile);
