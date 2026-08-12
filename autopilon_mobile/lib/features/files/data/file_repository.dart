import 'dart:io';
import 'dart:typed_data';
import '../../../core/api/api_client.dart';
import 'file_models.dart';

class FileRepository {
  FileRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<FileItem>>> listFiles({
    String? folderId, bool favoritesOnly = false, bool recentOnly = false, bool sharedWithMe = false, bool trashed = false, String? q,
  }) =>
      _api.get<List<FileItem>>(
        '/files',
        query: {
          if (folderId != null) 'folderId': folderId,
          if (favoritesOnly) 'favoritesOnly': 'true',
          if (recentOnly) 'recentOnly': 'true',
          if (sharedWithMe) 'sharedWithMe': 'true',
          if (trashed) 'trashed': 'true',
          if (q != null && q.isNotEmpty) 'q': q,
        },
        parse: (d) => (d as List).map((f) => FileItem.fromJson(f as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<List<FolderItem>>> listFolders({String? parentFolderId}) => _api.get<List<FolderItem>>(
        '/files/folders',
        query: {'parentFolderId': parentFolderId ?? ''},
        parse: (d) => (d as List).map((f) => FolderItem.fromJson(f as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<List<Breadcrumb>>> breadcrumb(String folderId) => _api.get<List<Breadcrumb>>(
        '/files/folders/$folderId/breadcrumb',
        parse: (d) => (d as List).map((b) => Breadcrumb.fromJson(b as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<FolderItem>> createFolder(String name, {String? parentFolderId}) => _api.post<FolderItem>(
        '/files/folders',
        body: {'name': name, if (parentFolderId != null) 'parentFolderId': parentFolderId},
        parse: (d) => FolderItem.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<FileItem>> upload(File file, {String? folderId}) => _api.uploadFile<FileItem>(
        '/files/upload',
        file,
        fields: {if (folderId != null) 'folderId': folderId},
        parse: (d) => FileItem.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<FileItem>> rename(String fileId, String filename) => _api.patch<FileItem>(
        '/files/$fileId',
        body: {'filename': filename},
        parse: (d) => FileItem.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<FileItem>> move(String fileId, String? folderId) => _api.patch<FileItem>(
        '/files/$fileId',
        body: {'folderId': folderId},
        parse: (d) => FileItem.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<FileItem>> setFavorite(String fileId, bool favorite) => _api.patch<FileItem>(
        '/files/$fileId',
        body: {'favorite': favorite},
        parse: (d) => FileItem.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<void>> trash(String fileId) => _api.delete<void>('/files/$fileId', parse: (_) {});
  Future<ApiResult<FileItem>> restore(String fileId) =>
      _api.post<FileItem>('/files/$fileId/restore', body: const {}, parse: (d) => FileItem.fromJson(d as Map<String, dynamic>));
  Future<ApiResult<void>> permanentlyDelete(String fileId) => _api.delete<void>('/files/$fileId/permanent', parse: (_) {});

  Future<ApiResult<Uint8List>> download(String fileId) => _api.getBytes('/files/$fileId/content');

  Future<ApiResult<void>> addToKnowledge(String fileId) =>
      _api.post<void>('/files/$fileId/add-to-knowledge', body: const {}, parse: (_) {});

  Future<ApiResult<StorageUsage>> usage() =>
      _api.get<StorageUsage>('/files/usage', parse: (d) => StorageUsage.fromJson(d as Map<String, dynamic>));
}
