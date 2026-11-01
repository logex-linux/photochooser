import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Photochooser

final class ImagePipelineTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    private func writeImage(named name: String, width: Int, height: Int) throws -> URL {
        let url = folder.appendingPathComponent(name)
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }

        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        context?.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
        context?.fill(CGRect(x: 0, y: 0, width: width, height: height))

        guard let image = context?.makeImage() else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return url
    }

    func testDecodeDownsamplesToRequestedPixelSize() throws {
        let url = try writeImage(named: "big.jpg", width: 1_200, height: 800)
        let decoded = try XCTUnwrap(ImagePipeline.decode(url, maxPixelSize: 200))
        XCTAssertLessThanOrEqual(max(decoded.cgImage.width, decoded.cgImage.height), 200)
        XCTAssertGreaterThan(decoded.cgImage.width, 100)
    }

    func testDecodeMissingFileReturnsNil() {
        let url = folder.appendingPathComponent("missing.jpg")
        XCTAssertNil(ImagePipeline.decode(url, maxPixelSize: 100))
    }

    @MainActor
    func testCacheEvictsLeastRecentlyUsed() throws {
        let cache = ImageCache(limit: 2)
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: 4,
            height: 4,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        let image = try XCTUnwrap(context.makeImage())

        let a = URL(fileURLWithPath: "/tmp/a.jpg")
        let b = URL(fileURLWithPath: "/tmp/b.jpg")
        let c = URL(fileURLWithPath: "/tmp/c.jpg")

        cache.insert(image, for: a)
        cache.insert(image, for: b)
        XCTAssertNotNil(cache.value(for: a))
        cache.insert(image, for: c)

        XCTAssertNil(cache.value(for: b), "b was the least recently used entry")
        XCTAssertNotNil(cache.value(for: a))
        XCTAssertNotNil(cache.value(for: c))
    }
}
