import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Handles "Open With" and `open -a Photochooser <folder>`.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        Task { @MainActor in
            PhotoStore.shared.openFolder(containing: url)
        }
    }
}

@main
@MainActor
struct PhotochooserApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = PhotoStore.shared

    var body: some Scene {
        WindowGroup("Photochooser", id: "main") {
            ContentView(store: store)
        }
        .defaultSize(width: 1_000, height: 700)
        .commands {
            CommandMenu("照片") {
                Button("保留并下一张") { store.keepAndNext() }
                    .keyboardShortcut("1", modifiers: [])
                    .disabled(!store.canDelete)

                Button("移到废纸篓") { store.deleteCurrent() }
                    .keyboardShortcut("2", modifiers: [])
                    .disabled(!store.canDelete)

                Button("撤回删除") { store.undoDelete() }
                    .keyboardShortcut("3", modifiers: [])
                    .disabled(!store.canUndo)

                Divider()

                Button("上一张") { store.previous() }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    .disabled(!store.canGoPrevious)

                Button("下一张") { store.next() }
                    .keyboardShortcut(.rightArrow, modifiers: [])
                    .disabled(!store.canGoNext)
            }
        }
    }
}
