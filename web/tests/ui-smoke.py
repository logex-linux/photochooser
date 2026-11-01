#!/usr/bin/env python3
"""Headless smoke test for the web build.

Serves a temporary copy of web/dist/web with a few photos, drives the app with
Playwright (keyboard + filmstrip), and checks that the single-file build also
decodes and draws. Run: python3 web/tests/ui-smoke.py
"""
import functools
import http.server
import shutil
import struct
import sys
import tempfile
import threading
import zlib
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def write_png(path, width, height, rgb):
    """Dependency-free PNG writer so the test needs no fixture files."""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def make_photos(directory):
    colors = [
        (240, 150, 110),
        (110, 160, 230),
        (120, 200, 180),
        (200, 130, 190),
        (230, 200, 120),
        (140, 150, 220),
    ]
    photos = []
    for index, color in enumerate(colors):
        path = directory / ("PC_%04d.png" % (index + 1))
        write_png(path, 900 + index * 60, 600 + index * 30, color)
        photos.append(path)
    return photos

STATE_JS = "() => window.Photochooser.getState()"
CANVAS_INK_JS = """
() => {
  const canvas = document.getElementById('preview');
  const context = canvas.getContext('2d');
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) ink += 1;
  }
  return { ink, pixels: data.length / 4, width: canvas.width, height: canvas.height };
}
"""


def specs_js(paths):
    return ", ".join(
        "{name: %r, b64: %r}" % (path.name, __import__("base64").b64encode(path.read_bytes()).decode())
        for path in paths
    )


DECODE_JS = """
      const files = specs.map((spec) => {
        const binary = atob(spec.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new File([bytes], spec.name, { type: spec.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' });
      });
"""


def make_files_js(paths):
    return """
    async () => {
      const specs = [%s];
      %s
      return window.Photochooser.openFiles(files);
    }
    """ % (specs_js(paths), DECODE_JS)


def make_handle_js(paths):
    return """
    async () => {
      const specs = [%s];
      %s
      const byName = new Map(files.map((file) => [file.name, file]));
      window.__deleted = [];
      window.showDirectoryPicker = async () => ({
        name: 'MockFolder',
        async *entries() {
          for (const name of Array.from(byName.keys()).reverse()) {
            yield [name, {
              kind: 'file',
              name,
              getFile: async () => byName.get(name),
              remove: async () => { window.__deleted.push(name); byName.delete(name); }
            }];
          }
        }
      });
    }
    """ % (specs_js(paths), DECODE_JS)


def start_server(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("  ok:", message)


def main():
    if not (ROOT / "dist" / "web").exists():
        sys.exit("run `node web/build.mjs` first")

    workspace = Path(tempfile.mkdtemp(prefix="photochooser-web-"))
    web = workspace / "web"
    shutil.copytree(ROOT / "dist" / "web", web)
    fixtures = web / "fixtures"
    fixtures.mkdir()
    photos = make_photos(fixtures)

    server, port = start_server(web)
    base = "http://127.0.0.1:%d/" % port

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 860})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

            print("multi-file build")
            page.goto(base, wait_until="load")
            check(page.title().startswith("Photochooser"), "page loads with title")
            page.screenshot(path="/tmp/photochooser-empty.png")

            count = page.evaluate(make_files_js(photos))
            check(count == 6, "openFiles loaded 6 photos")
            page.wait_for_timeout(700)

            state = page.evaluate(STATE_JS)
            check(state["total"] == 6 and state["index"] == 0, "starts on the first photo")

            ink = page.evaluate(CANVAS_INK_JS)
            check(ink["ink"] > ink["pixels"] * 0.2, "preview canvas has image pixels (%s)" % ink["ink"])

            check(page.locator(".thumb").count() == 6, "filmstrip renders 6 cells")
            page.wait_for_timeout(500)
            check(page.locator(".thumb img").count() >= 1, "filmstrip thumbnails decode")

            page.keyboard.press("2")
            page.wait_for_timeout(250)
            state = page.evaluate(STATE_JS)
            check(state["rejected"] == 1 and state["index"] == 1, "key 2 marks delete and advances")
            check("is-rejected" in (page.locator(".thumb").first.get_attribute("class") or ""),
                  "rejected thumbnail is flagged")
            check(page.locator("#applyBtn").is_visible(), "apply button appears")

            page.keyboard.press("ArrowLeft")
            page.wait_for_timeout(250)
            check(not page.locator("#rejectedFlag").is_hidden(), "rejected photo shows its flag")

            page.keyboard.press("3")
            page.wait_for_timeout(250)
            state = page.evaluate(STATE_JS)
            check(state["rejected"] == 0 and state["index"] == 0, "key 3 undoes and returns")

            page.keyboard.press("1")
            page.wait_for_timeout(250)
            state = page.evaluate(STATE_JS)
            check(state["kept"] == 1 and state["index"] == 1, "key 1 keeps and advances")

            page.keyboard.press("ArrowRight")
            page.wait_for_timeout(200)
            check(page.evaluate(STATE_JS)["index"] == 2, "arrow keys navigate")

            page.screenshot(path="/tmp/photochooser-web.png")

            check(not errors, "no page errors: %s" % errors)

            print("browser folder path (mock directory handle)")
            page.goto(base, wait_until="load")
            page.on("dialog", lambda dialog: dialog.accept())
            page.evaluate(make_handle_js(photos))
            page.click("#openBtn")
            page.wait_for_timeout(900)
            state = page.evaluate(STATE_JS)
            check(state["total"] == 6, "directory handle entries are listed")
            check(page.locator("#sourceKind").inner_text().startswith("浏览器版"), "source is reported")
            check(page.locator(".thumb").count() == 6, "filmstrip rebuilt for the new folder")

            page.keyboard.press("2")
            page.wait_for_timeout(200)
            page.click("#applyBtn")
            page.wait_for_timeout(700)
            state = page.evaluate(STATE_JS)
            deleted = page.evaluate("() => window.__deleted")
            check(state["total"] == 5, "deleting through the handle removes the entry")
            check(len(deleted) == 1, "the file handle remove() was called")
            check(not page.locator("#applyBtn").is_visible(), "apply button disappears after cleanup")

            print("single-file build")
            single = page.goto("file://" + str(ROOT / "dist" / "photochooser.html"), wait_until="load")
            check(single is not None, "single file loads")
            count = page.evaluate(make_files_js(photos))
            check(count == 6, "single file accepts files")
            page.wait_for_timeout(900)
            ink = page.evaluate(CANVAS_INK_JS)
            check(ink["ink"] > ink["pixels"] * 0.2, "single-file preview draws (inline worker)")
            page.screenshot(path="/tmp/photochooser-web-single.png")
            check(not errors, "no page errors after single-file run: %s" % errors)

            browser.close()
    finally:
        server.shutdown()
        shutil.rmtree(workspace, ignore_errors=True)

    print("web smoke test passed")


if __name__ == "__main__":
    main()
