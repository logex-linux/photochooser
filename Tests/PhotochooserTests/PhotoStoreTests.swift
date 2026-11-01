import Foundation
import XCTest
@testable import Photochooser

@MainActor
final class PhotoStoreTests: XCTestCase {
    func testPhotoScannerFiltersAndSortsSupportedFiles() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        for name in ["10.HEIF", "2.jpg", "ignore.png", "1.heic", "3.jpeg", "4.HIF"] {
            FileManager.default.createFile(
                atPath: folder.appendingPathComponent(name).path,
                contents: Data()
            )
        }

        let names = try PhotoStore.photoURLs(in: folder).map(\.lastPathComponent)
        XCTAssertEqual(names, ["1.heic", "2.jpg", "3.jpeg", "4.HIF", "10.HEIF"])
    }
}
