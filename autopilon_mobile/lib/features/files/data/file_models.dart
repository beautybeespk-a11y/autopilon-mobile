class FileItem {
  final String id;
  final String filename;
  final String? extension;
  final String? mimeType;
  final int sizeBytes;
  final String? folderId;
  final int version;
  final String status;
  final String processingStatus;
  final String? extractedText;
  final bool previewSupport;
  final bool textExtractionSupport;
  final String visibility;
  final bool favorite;
  final String updatedAt;
  final List<String> tags;

  FileItem({
    required this.id,
    required this.filename,
    this.extension,
    this.mimeType,
    required this.sizeBytes,
    this.folderId,
    required this.version,
    required this.status,
    required this.processingStatus,
    this.extractedText,
    required this.previewSupport,
    required this.textExtractionSupport,
    required this.visibility,
    required this.favorite,
    required this.updatedAt,
    this.tags = const [],
  });

  factory FileItem.fromJson(Map<String, dynamic> json) => FileItem(
        id: json['id']?.toString() ?? '',
        filename: json['filename'] ?? '',
        extension: json['extension'],
        mimeType: json['mimeType'],
        sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
        folderId: json['folderId'],
        version: (json['version'] as num?)?.toInt() ?? 1,
        status: json['status'] ?? 'active',
        processingStatus: json['processingStatus'] ?? 'ready',
        extractedText: json['extractedText'],
        previewSupport: json['previewSupport'] == true || json['previewSupport'] == 1,
        textExtractionSupport: json['textExtractionSupport'] == true || json['textExtractionSupport'] == 1,
        visibility: json['visibility'] ?? 'private',
        favorite: json['favorite'] == true || json['favorite'] == 1,
        updatedAt: json['updatedAt'] ?? '',
        tags: (json['tags'] as List? ?? []).map((t) => t.toString()).toList(),
      );

  FileItem copyWith({bool? favorite, String? filename, String? folderId}) => FileItem(
        id: id, filename: filename ?? this.filename, extension: extension, mimeType: mimeType, sizeBytes: sizeBytes,
        folderId: folderId ?? this.folderId, version: version, status: status, processingStatus: processingStatus,
        extractedText: extractedText, previewSupport: previewSupport, textExtractionSupport: textExtractionSupport,
        visibility: visibility, favorite: favorite ?? this.favorite, updatedAt: updatedAt, tags: tags,
      );
}

class FolderItem {
  final String id;
  final String name;
  final String? parentFolderId;

  FolderItem({required this.id, required this.name, this.parentFolderId});

  factory FolderItem.fromJson(Map<String, dynamic> json) => FolderItem(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        parentFolderId: json['parentFolderId'],
      );
}

class Breadcrumb {
  final String id;
  final String name;
  Breadcrumb({required this.id, required this.name});
  factory Breadcrumb.fromJson(Map<String, dynamic> json) => Breadcrumb(id: json['id'] ?? '', name: json['name'] ?? '');
}

class StorageUsage {
  final int usedBytes;
  final int? limitBytes;
  final int fileCount;
  final int percentUsed;

  StorageUsage({required this.usedBytes, this.limitBytes, required this.fileCount, required this.percentUsed});

  factory StorageUsage.fromJson(Map<String, dynamic> json) => StorageUsage(
        usedBytes: (json['usage']?['usedBytes'] as num?)?.toInt() ?? 0,
        limitBytes: (json['quota']?['limit'] as num?)?.toInt(),
        fileCount: (json['usage']?['fileCount'] as num?)?.toInt() ?? 0,
        percentUsed: (json['quota']?['percentUsed'] as num?)?.toInt() ?? 0,
      );
}
