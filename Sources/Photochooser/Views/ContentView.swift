import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    let store: PhotoStore
    @State private var isChoosingFolder = false

    var body: some View {
        @Bindable var store = store

        VStack(spacing: 0) {
            photoArea
            if !store.photos.isEmpty {
                Divider()
                FilmstripView(store: store)
            }
            Divider()
            controls
        }
        .frame(minWidth: 760, minHeight: 520)
        .navigationTitle(store.folderName ?? "Photochooser")
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            store.openFolder(containing: url)
            return true
        }
        .toolbar {
            ToolbarItem {
                Button("选择照片文件夹", systemImage: "folder") {
                    isChoosingFolder = true
                }
                .accessibilityHint("选择包含 HIF、HEIF、HEIC 或 JPG 照片的文件夹")
            }
        }
        .fileImporter(
            isPresented: $isChoosingFolder,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                if let folder = urls.first { store.openFolder(folder) }
            case .failure(let error):
                store.errorMessage = error.localizedDescription
                store.isShowingError = true
            }
        }
        .alert("操作失败", isPresented: $store.isShowingError) {
            Button("好") {}
        } message: {
            Text(store.errorMessage)
        }
    }

    @ViewBuilder
    private var photoArea: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)

            if let image = store.currentImage, let name = store.currentName {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .padding()
                    .accessibilityLabel("照片：\(name)")
                    .transition(.opacity)
            } else if store.isLoadingImage {
                ProgressView()
                    .controlSize(.large)
            } else if store.isScanningFolder {
                ProgressView("正在扫描文件夹…")
            } else {
                ContentUnavailableView {
                    Label(
                        store.folderURL == nil ? "选择照片文件夹" : "没有可显示的照片",
                        systemImage: "photo.on.rectangle.angled"
                    )
                } description: {
                    Text("支持 HIF、HEIF、HEIC、JPG 和 JPEG")
                } actions: {
                    Button("选择文件夹") { isChoosingFolder = true }
                }
            }

            if store.isLoadingImage, store.currentImage != nil {
                ProgressView()
                    .controlSize(.small)
                    .padding(8)
                    .background(.regularMaterial, in: .rect(cornerRadius: 8))
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.12), value: store.currentImage == nil)
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Button("上一张", systemImage: "chevron.left") { store.previous() }
                .disabled(!store.canGoPrevious)

            Button("保留 · 1") { store.keepAndNext() }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canDelete)

            Button("删除 · 2", role: .destructive) { store.deleteCurrent() }
                .disabled(!store.canDelete)

            Button("撤回 · 3", systemImage: "arrow.uturn.backward") { store.undoDelete() }
                .disabled(!store.canUndo)

            Button("下一张", systemImage: "chevron.right") { store.next() }
                .disabled(!store.canGoNext)

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(store.currentName ?? "未选择文件夹")
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Text(store.progressText)
                    Text(store.keptText)
                    Text(store.deletedText)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(12)
    }
}

private struct FilmstripView: View {
    let store: PhotoStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(Array(store.photos.enumerated()), id: \.element) { index, url in
                        FilmstripCell(store: store, url: url, isCurrent: index == store.currentIndex)
                            .id(url)
                            .onTapGesture { store.select(index) }
                            .accessibilityLabel("第 \(index + 1) 张：\(url.lastPathComponent)")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .frame(height: 88)
            .background(.bar)
            .onChange(of: store.currentIndex) { _, _ in
                guard let url = store.currentURL else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(url, anchor: .center)
                }
            }
            .onChange(of: store.photos.count) { _, _ in
                guard let url = store.currentURL else { return }
                proxy.scrollTo(url, anchor: .center)
            }
        }
    }
}

private struct FilmstripCell: View {
    let store: PhotoStore
    let url: URL
    let isCurrent: Bool

    @State private var image: CGImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .underPageBackgroundColor))

            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 64, height: 64)
                    .clipped()
                    .clipShape(.rect(cornerRadius: 6))
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(width: 64, height: 64)
        .clipped()
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isCurrent ? Color.accentColor : .clear, lineWidth: 3)
        }
        .contentShape(.rect)
        .task(id: url) {
            if let cached = store.cachedThumbnail(for: url) {
                image = cached
                return
            }
            image = await store.thumbnail(for: url)
        }
    }
}
