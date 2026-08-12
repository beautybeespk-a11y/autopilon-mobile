import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_client.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/file_models.dart';
import '../data/file_repository.dart';

final fileRepositoryProvider = Provider<FileRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return FileRepository(apiClientAsync.requireValue);
});

enum FilesTab { myFiles, recent, favorites, shared, trash }

class FilesState {
  final FilesTab tab;
  final String? currentFolderId;
  final List<Breadcrumb> breadcrumb;
  final List<FolderItem> folders;
  final List<FileItem> files;
  final bool loading;
  final String? error;
  final String query;

  const FilesState({
    this.tab = FilesTab.myFiles,
    this.currentFolderId,
    this.breadcrumb = const [],
    this.folders = const [],
    this.files = const [],
    this.loading = true,
    this.error,
    this.query = '',
  });

  FilesState copyWith({
    FilesTab? tab,
    String? currentFolderId,
    bool clearFolder = false,
    List<Breadcrumb>? breadcrumb,
    List<FolderItem>? folders,
    List<FileItem>? files,
    bool? loading,
    String? error,
    bool clearError = false,
    String? query,
  }) =>
      FilesState(
        tab: tab ?? this.tab,
        currentFolderId: clearFolder ? null : (currentFolderId ?? this.currentFolderId),
        breadcrumb: breadcrumb ?? this.breadcrumb,
        folders: folders ?? this.folders,
        files: files ?? this.files,
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
        query: query ?? this.query,
      );
}

/// Mirrors Files.jsx's data-loading shape — one controller, one `load()`
/// that branches on the active tab, same simplification (a folder tree is
/// only browsed under "My Files"; every other tab is a flat filtered list).
class FilesController extends StateNotifier<FilesState> {
  FilesController(this._ref) : super(const FilesState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    final repo = _ref.read(fileRepositoryProvider);

    if (state.tab == FilesTab.myFiles) {
      final folderResult = await repo.listFolders(parentFolderId: state.currentFolderId);
      final fileResult = await repo.listFiles(folderId: state.currentFolderId ?? '', q: state.query.isEmpty ? null : state.query);
      final crumbs = state.currentFolderId != null ? (await repo.breadcrumb(state.currentFolderId!)).data ?? [] : <Breadcrumb>[];
      state = state.copyWith(
        folders: folderResult.data ?? [],
        files: fileResult.data ?? [],
        breadcrumb: crumbs,
        loading: false,
        error: (folderResult.error ?? fileResult.error),
      );
    } else {
      final result = await repo.listFiles(
        q: state.query.isEmpty ? null : state.query,
        recentOnly: state.tab == FilesTab.recent,
        favoritesOnly: state.tab == FilesTab.favorites,
        sharedWithMe: state.tab == FilesTab.shared,
        trashed: state.tab == FilesTab.trash,
      );
      state = state.copyWith(folders: [], files: result.data ?? [], breadcrumb: [], loading: false, error: result.error);
    }
  }

  void setTab(FilesTab tab) {
    state = state.copyWith(tab: tab, clearFolder: true, breadcrumb: [], query: '');
    load();
  }

  void openFolder(String? folderId) {
    state = folderId == null ? state.copyWith(clearFolder: true) : state.copyWith(currentFolderId: folderId);
    load();
  }

  void setQuery(String q) {
    state = state.copyWith(query: q);
    load();
  }

  Future<ApiResult<FolderItem>> createFolder(String name) async {
    final result = await _ref.read(fileRepositoryProvider).createFolder(name, parentFolderId: state.currentFolderId);
    if (result.isSuccess) load();
    return result;
  }

  Future<void> toggleFavorite(FileItem file) async {
    final result = await _ref.read(fileRepositoryProvider).setFavorite(file.id, !file.favorite);
    if (result.isSuccess) load();
  }

  Future<ApiResult<void>> trashFile(FileItem file) async {
    final result = await _ref.read(fileRepositoryProvider).trash(file.id);
    if (result.isSuccess) load();
    return result;
  }

  Future<void> restoreFile(FileItem file) async {
    final result = await _ref.read(fileRepositoryProvider).restore(file.id);
    if (result.isSuccess) load();
  }

  Future<ApiResult<void>> permanentlyDelete(FileItem file) async {
    final result = await _ref.read(fileRepositoryProvider).permanentlyDelete(file.id);
    if (result.isSuccess) load();
    return result;
  }

  Future<ApiResult<FileItem>> rename(FileItem file, String newName) async {
    final result = await _ref.read(fileRepositoryProvider).rename(file.id, newName);
    if (result.isSuccess) load();
    return result;
  }
}

final filesControllerProvider = StateNotifierProvider.autoDispose<FilesController, FilesState>((ref) => FilesController(ref));
