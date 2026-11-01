import AppKit
import CoreGraphics
import Foundation
import Observation

@MainActor
@Observable
final class PhotoStore {
    static let shared = PhotoStore()

    private struct DeletedPhoto {
        let originalURL: URL
        let trashURL: URL
    }

    nonisolated private static let supportedExtensions: Set<String> = ["hif", "heic", "heif", "jpg", "jpeg"]
    nonisolated private static let previewMaxPixel = 2_000
    nonisolated private static let thumbnailMaxPixel = 220
    nonisolated private static let prefetchOffsets = [1, 2, -1]

    private(set) var photos: [URL] = []
    private(set) var currentIndex = 0
    private(set) var currentImage: CGImage?
    private(set) var folderURL: URL?
    private(set) var isLoadingImage = false
    private(set) var isScanningFolder = false
    private(set) var keptCount = 0
    var errorMessage = ""
    var isShowingError = false

    private let previewCache = ImageCache(limit: 6)
    private let thumbnailCache = ImageCache(limit: 800)
    private var deletedPhotos: [DeletedPhoto] = []
    private var securityScopedFolder: URL?

    private var previewTask: Task<Void, Never>?
    private var prefetchTask: Task<Void, Never>?
    private var scanTask: Task<Void, Never>?
    private var loadGeneration = 0

    var currentURL: URL? {
        photos.indices.contains(currentIndex) ? photos[currentIndex] : nil
    }

    var folderName: String? { folderURL?.lastPathComponent }
    var currentName: String? { currentURL?.lastPathComponent }
    var progressText: String { photos.isEmpty ? "0 张" : "\(currentIndex + 1) / \(photos.count)" }
    var keptText: String { "保留 \(keptCount)" }
    var deletedText: String { "已删除 \(deletedPhotos.count)" }
    var canGoPrevious: Bool { currentIndex > 0 }
    var canGoNext: Bool { currentIndex < photos.count - 1 }
    var canDelete: Bool { currentURL != nil }
    var canUndo: Bool { !deletedPhotos.isEmpty }

    /// Opens `url` when it is a folder, or the containing folder when it is a photo.
    func openFolder(containing url: URL) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return }
        openFolder(isDirectory.boolValue ? url : url.deletingLastPathComponent())
    }

    func openFolder(_ url: URL) {
        if let securityScopedFolder {
            securityScopedFolder.stopAccessingSecurityScopedResource()
        }
        securityScopedFolder = url.startAccessingSecurityScopedResource() ? url : nil

        cancelWork()
        folderURL = url
        photos = []
        currentIndex = 0
        currentImage = nil
        keptCount = 0
        deletedPhotos.removeAll()
        previewCache.removeAll()
        thumbnailCache.removeAll()
        isScanningFolder = true

        scanTask = Task { [weak self] in
            let outcome = await Task.detached(priority: .userInitiated) { () -> ([URL]?, String?) in
                do {
                    return (try PhotoStore.photoURLs(in: url), nil)
                } catch {
                    return (nil, error.localizedDescription)
                }
            }.value

            guard let self, !Task.isCancelled else { return }
            self.isScanningFolder = false

            if let scanned = outcome.0 {
                self.photos = scanned
                self.loadCurrentImage()
            } else if let message = outcome.1 {
                self.showError(message)
            }
        }
    }

    func select(_ index: Int) {
        guard photos.indices.contains(index), index != currentIndex else { return }
        currentIndex = index
        loadCurrentImage()
    }

    func keepAndNext() {
        guard currentURL != nil else { return }
        keptCount += 1
        if canGoNext {
            next()
        } else {
            loadCurrentImage()
        }
    }

    func previous() {
        guard canGoPrevious else { return }
        currentIndex -= 1
        loadCurrentImage()
    }

    func next() {
        guard canGoNext else { return }
        currentIndex += 1
        loadCurrentImage()
    }

    func deleteCurrent() {
        guard let originalURL = currentURL else { return }
        var trashedURL: NSURL?

        do {
            try FileManager.default.trashItem(at: originalURL, resultingItemURL: &trashedURL)
            guard let trashURL = trashedURL as URL? else {
                throw CocoaError(.fileWriteUnknown)
            }

            deletedPhotos.append(DeletedPhoto(originalURL: originalURL, trashURL: trashURL))
            previewCache.remove(originalURL)
            thumbnailCache.remove(originalURL)
            photos.remove(at: currentIndex)
            currentIndex = min(currentIndex, max(photos.count - 1, 0))
            loadCurrentImage()
        } catch {
            showError(error.localizedDescription)
        }
    }

    func undoDelete() {
        guard let deleted = deletedPhotos.last else { return }

        do {
            try FileManager.default.moveItem(at: deleted.trashURL, to: deleted.originalURL)
            deletedPhotos.removeLast()
            photos.append(deleted.originalURL)
            photos.sort(by: Self.sortPhotos)
            currentIndex = photos.firstIndex(of: deleted.originalURL) ?? 0
            loadCurrentImage()
        } catch {
            showError(error.localizedDescription)
        }
    }

    // MARK: - Thumbnails

    func cachedThumbnail(for url: URL) -> CGImage? {
        thumbnailCache.value(for: url)
    }

    func thumbnail(for url: URL) async -> CGImage? {
        if let cached = thumbnailCache.value(for: url) {
            return cached
        }
        let maxPixel = Self.thumbnailMaxPixel
        let decoded = await Task.detached(priority: .utility) {
            ImagePipeline.decode(url, maxPixelSize: maxPixel)
        }.value

        guard !Task.isCancelled, let image = decoded?.cgImage else { return nil }
        thumbnailCache.insert(image, for: url)
        return image
    }

    // MARK: - Loading

    private func loadCurrentImage() {
        previewTask?.cancel()
        prefetchTask?.cancel()
        loadGeneration &+= 1

        guard let url = currentURL else {
            currentImage = nil
            isLoadingImage = false
            return
        }

        if let cached = previewCache.value(for: url) {
            currentImage = cached
            isLoadingImage = false
            schedulePrefetch()
            return
        }

        let generation = loadGeneration
        let maxPixel = Self.previewMaxPixel
        currentImage = nil
        isLoadingImage = true

        previewTask = Task { [weak self] in
            let decoded = await Task.detached(priority: .userInitiated) {
                ImagePipeline.decode(url, maxPixelSize: maxPixel)
            }.value

            guard let self, !Task.isCancelled, self.loadGeneration == generation else { return }
            self.isLoadingImage = false

            guard let image = decoded?.cgImage else {
                self.showError("无法解码 \(url.lastPathComponent)")
                return
            }
            self.previewCache.insert(image, for: url)
            self.currentImage = image
            self.schedulePrefetch()
        }
    }

    /// Decodes neighbours ahead of time so arrow-key navigation feels instant.
    private func schedulePrefetch() {
        let urls = Self.prefetchOffsets.compactMap { offset -> URL? in
            let index = currentIndex + offset
            guard photos.indices.contains(index) else { return nil }
            let url = photos[index]
            return previewCache.value(for: url) == nil ? url : nil
        }
        guard !urls.isEmpty else { return }

        let maxPixel = Self.previewMaxPixel
        prefetchTask = Task(priority: .utility) { [weak self] in
            for url in urls {
                if Task.isCancelled { return }
                let decoded = await Task.detached(priority: .utility) {
                    ImagePipeline.decode(url, maxPixelSize: maxPixel)
                }.value
                if Task.isCancelled { return }
                guard let self, let image = decoded?.cgImage else { continue }
                self.previewCache.insert(image, for: url)
            }
        }
    }

    private func cancelWork() {
        previewTask?.cancel()
        prefetchTask?.cancel()
        scanTask?.cancel()
        previewTask = nil
        prefetchTask = nil
        scanTask = nil
    }

    // MARK: - Scanning

    nonisolated static func photoURLs(in folder: URL) throws -> [URL] {
        try FileManager.default
            .contentsOfDirectory(
                at: folder,
                includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            .filter { url in
                let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
                return values?.isRegularFile == true
                    && supportedExtensions.contains(url.pathExtension.lowercased())
            }
            .sorted(by: sortPhotos)
    }

    nonisolated private static func sortPhotos(_ first: URL, _ second: URL) -> Bool {
        first.lastPathComponent.localizedStandardCompare(second.lastPathComponent) == .orderedAscending
    }

    private func showError(_ message: String) {
        errorMessage = message
        isShowingError = true
    }
}
