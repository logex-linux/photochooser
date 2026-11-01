import CoreGraphics
import Foundation
import ImageIO

/// A decoded image that can be handed between concurrency domains.
///
/// `CGImage` is immutable once created, so sharing it across threads is safe
/// even though the type itself is not annotated as `Sendable`.
struct DecodedImage: @unchecked Sendable {
    let cgImage: CGImage
}

enum ImagePipeline {
    /// Decodes `url` at most `maxPixelSize` points on the long edge.
    ///
    /// ImageIO downsamples while decoding, so a 48 MP HEIC never materialises
    /// as a full-resolution bitmap in memory.
    static func decode(_ url: URL, maxPixelSize: Int) -> DecodedImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return DecodedImage(cgImage: image)
    }
}

/// Small least-recently-used cache for decoded images, kept on the main actor.
@MainActor
final class ImageCache {
    private var storage: [URL: CGImage] = [:]
    private var recency: [URL] = []
    private let limit: Int

    init(limit: Int) {
        self.limit = max(limit, 1)
    }

    var count: Int { storage.count }

    func value(for url: URL) -> CGImage? {
        guard let image = storage[url] else { return nil }
        touch(url)
        return image
    }

    func insert(_ image: CGImage, for url: URL) {
        storage[url] = image
        touch(url)
        while storage.count > limit, let oldest = recency.first {
            recency.removeFirst()
            storage[oldest] = nil
        }
    }

    func remove(_ url: URL) {
        storage[url] = nil
        recency.removeAll { $0 == url }
    }

    func removeAll() {
        storage.removeAll()
        recency.removeAll()
    }

    private func touch(_ url: URL) {
        recency.removeAll { $0 == url }
        recency.append(url)
    }
}
