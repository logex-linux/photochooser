#!/usr/bin/env swift
import AppKit
import Foundation

// Draws the Photochooser app icon and writes an .iconset + .icns.
// Usage: swift script/make_icon.swift <output-dir>

let outputDir = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    : URL(fileURLWithPath: "dist/icon", isDirectory: true)
try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))

image.lockFocus()
guard let context = NSGraphicsContext.current?.cgContext else {
    fatalError("no graphics context")
}

func color(_ hex: UInt32) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
    )
}

// Squircle background with a diagonal gradient.
let inset = size * 0.045
let background = NSBezierPath(
    roundedRect: NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2),
    xRadius: size * 0.225,
    yRadius: size * 0.225
)
let gradient = NSGradient(colors: [color(0x4F8CFF), color(0x8A5BFF)])!
gradient.draw(in: background, angle: -55)

// Soft highlight in the upper left.
context.saveGState()
background.addClip()
let highlight = NSGradient(colors: [
    NSColor(white: 1, alpha: 0.28),
    NSColor(white: 1, alpha: 0.0)
])!
highlight.draw(
    in: NSBezierPath(ovalIn: NSRect(x: -size * 0.15, y: size * 0.42, width: size * 0.95, height: size * 0.85)),
    angle: -90
)
context.restoreGState()

// Photo card.
let cardRect = NSRect(x: size * 0.215, y: size * 0.285, width: size * 0.57, height: size * 0.43)
let card = NSBezierPath(roundedRect: cardRect, xRadius: size * 0.055, yRadius: size * 0.055)
NSColor(white: 1, alpha: 0.97).setFill()
card.fill()

// Card content (sky, sun, mountains) clipped to the card.
context.saveGState()
card.addClip()

let sky = NSGradient(colors: [color(0xDCEBFF), color(0xF7FBFF)])!
sky.draw(in: cardRect, angle: -90)

color(0xFFC64D).setFill()
NSBezierPath(ovalIn: NSRect(
    x: cardRect.maxX - size * 0.17,
    y: cardRect.maxY - size * 0.15,
    width: size * 0.09,
    height: size * 0.09
)).fill()

let backMountain = NSBezierPath()
backMountain.move(to: NSPoint(x: cardRect.minX - size * 0.02, y: cardRect.minY))
backMountain.line(to: NSPoint(x: cardRect.minX + size * 0.20, y: cardRect.minY + size * 0.26))
backMountain.line(to: NSPoint(x: cardRect.minX + size * 0.42, y: cardRect.minY))
backMountain.close()
color(0x6FA8FF).setFill()
backMountain.fill()

let frontMountain = NSBezierPath()
frontMountain.move(to: NSPoint(x: cardRect.minX + size * 0.14, y: cardRect.minY))
frontMountain.line(to: NSPoint(x: cardRect.minX + size * 0.36, y: cardRect.minY + size * 0.22))
frontMountain.line(to: NSPoint(x: cardRect.minX + size * 0.58, y: cardRect.minY))
frontMountain.close()
color(0x2F6BD8).setFill()
frontMountain.fill()
context.restoreGState()

// Check badge.
let badgeSize = size * 0.26
let badgeRect = NSRect(
    x: size * 0.635,
    y: size * 0.175,
    width: badgeSize,
    height: badgeSize
)
NSColor(white: 1, alpha: 0.95).setFill()
NSBezierPath(ovalIn: badgeRect.insetBy(dx: -size * 0.018, dy: -size * 0.018)).fill()

let badgeGradient = NSGradient(colors: [color(0x34D399), color(0x10B981)])!
badgeGradient.draw(in: NSBezierPath(ovalIn: badgeRect), angle: -90)

let check = NSBezierPath()
check.lineWidth = size * 0.045
check.lineCapStyle = .round
check.lineJoinStyle = .round
check.move(to: NSPoint(x: badgeRect.minX + badgeSize * 0.27, y: badgeRect.minY + badgeSize * 0.52))
check.line(to: NSPoint(x: badgeRect.minX + badgeSize * 0.44, y: badgeRect.minY + badgeSize * 0.34))
check.line(to: NSPoint(x: badgeRect.minX + badgeSize * 0.75, y: badgeRect.minY + badgeSize * 0.68))
NSColor.white.setStroke()
check.stroke()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
else {
    fatalError("failed to encode icon")
}

let masterURL = outputDir.appendingPathComponent("icon_1024.png")
try png.write(to: masterURL)

let iconset = outputDir.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let variants: [(name: String, pixels: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024)
]

for variant in variants {
    let destination = iconset.appendingPathComponent("\(variant.name).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    process.arguments = ["-z", "\(variant.pixels)", "\(variant.pixels)", masterURL.path, "--out", destination.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
}

let icns = outputDir.appendingPathComponent("AppIcon.icns")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try iconutil.run()
iconutil.waitUntilExit()

print(icns.path)
