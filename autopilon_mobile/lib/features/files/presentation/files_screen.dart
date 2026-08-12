import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../data/file_models.dart';
import '../providers/files_provider.dart';
import 'file_actions_sheet.dart';

const _tabDefs = [
  (FilesTab.myFiles, 'My Files', Icons.folder_outlined),
  (FilesTab.recent, 'Recent', Icons.access_time),
  (FilesTab.favorites, 'Favorites', Icons.star_outline),
  (FilesTab.shared, 'Shared', Icons.people_outline),
  (FilesTab.trash, 'Trash', Icons.delete_outline),
];

class FilesScreen extends ConsumerStatefulWidget {
  const FilesScreen({super.key});
  @override
  ConsumerState<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends ConsumerState<FilesScreen> {
  final _searchCtrl = TextEditingController();
  bool _uploading = false;

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _upload(File file) async {
    setState(() => _uploading = true);
    final state = ref.read(filesControllerProvider);
    final repo = ref.read(fileRepositoryProvider);
    final result = await repo.upload(file, folderId: state.currentFolderId);
    setState(() => _uploading = false);
    if (result.isSuccess) {
      ref.read(filesControllerProvider.notifier).load();
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result.error ?? 'Upload failed.')));
    }
  }

  void _showUploadMenu() {
    showModalBottomSheet(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Camera'),
              onTap: () async {
                Navigator.pop(sheetContext);
                final picked = await ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 90);
                if (picked != null) await _upload(File(picked.path));
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Photo Library'),
              onTap: () async {
                Navigator.pop(sheetContext);
                final picked = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 90);
                if (picked != null) await _upload(File(picked.path));
              },
            ),
            ListTile(
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: const Text('Document'),
              onTap: () async {
                Navigator.pop(sheetContext);
                final result = await FilePicker.platform.pickFiles();
                final path = result?.files.single.path;
                if (path != null) await _upload(File(path));
              },
            ),
            ListTile(
              leading: const Icon(Icons.create_new_folder_outlined),
              title: const Text('New folder'),
              onTap: () {
                Navigator.pop(sheetContext);
                _showNewFolderDialog();
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showNewFolderDialog() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('New folder'),
        content: TextField(controller: controller, autofocus: true, decoration: const InputDecoration(hintText: 'Folder name')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, controller.text), child: const Text('Create')),
        ],
      ),
    );
    if (name == null || name.trim().isEmpty) return;
    final result = await ref.read(filesControllerProvider.notifier).createFolder(name.trim());
    if (!result.isSuccess && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result.error ?? "Couldn't create folder.")));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(filesControllerProvider);
    final controller = ref.read(filesControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Files')),
      body: Column(
        children: [
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: _tabDefs.map((t) {
                final active = state.tab == t.$1;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                  child: ChoiceChip(
                    label: Text(t.$2),
                    avatar: Icon(t.$3, size: 16),
                    selected: active,
                    onSelected: (_) => controller.setTab(t.$1),
                  ),
                );
              }).toList(),
            ),
          ),
          if (state.tab == FilesTab.myFiles && state.breadcrumb.isNotEmpty)
            SizedBox(
              height: 32,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                children: [
                  TextButton(onPressed: () => controller.openFolder(null), child: const Text('My Files')),
                  ...state.breadcrumb.map((b) => Row(mainAxisSize: MainAxisSize.min, children: [
                        const Icon(Icons.chevron_right, size: 16, color: Colors.grey),
                        TextButton(onPressed: () => controller.openFolder(b.id), child: Text(b.name)),
                      ])),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: TextField(
              controller: _searchCtrl,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search files', isDense: true, border: OutlineInputBorder()),
              onChanged: (v) => controller.setQuery(v),
            ),
          ),
          if (_uploading) const LinearProgressIndicator(),
          Expanded(child: _buildBody(state, controller)),
        ],
      ),
      floatingActionButton: FloatingActionButton(onPressed: _showUploadMenu, child: const Icon(Icons.add)),
    );
  }

  Widget _buildBody(FilesState state, FilesController controller) {
    if (state.loading) return const Center(child: CircularProgressIndicator());
    if (state.folders.isEmpty && state.files.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(state.tab == FilesTab.trash ? Icons.delete_outline : Icons.folder_open, size: 48, color: Colors.grey),
              const SizedBox(height: 12),
              Text(state.tab == FilesTab.trash ? 'Trash is empty' : 'Nothing here yet', style: Theme.of(context).textTheme.titleMedium),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: controller.load,
      child: ListView(
        children: [
          ...state.folders.map((f) => ListTile(
                leading: const Icon(Icons.folder, color: Colors.amber),
                title: Text(f.name),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => controller.openFolder(f.id),
              )),
          ...state.files.map((file) => ListTile(
                leading: Icon(_iconFor(file.extension), color: Colors.grey[600]),
                title: Text(file.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('${(file.sizeBytes / 1024).toStringAsFixed(1)} KB'),
                trailing: file.favorite ? const Icon(Icons.star, color: Colors.amber, size: 18) : null,
                onTap: () => showFileActionsSheet(context, ref, file),
              )),
        ],
      ),
    );
  }
}

IconData _iconFor(String? extension) {
  switch ((extension ?? '').toLowerCase()) {
    case 'pdf':
    case 'doc':
    case 'docx':
    case 'txt':
    case 'md':
      return Icons.description_outlined;
    case 'csv':
    case 'xls':
    case 'xlsx':
      return Icons.table_chart_outlined;
    case 'ppt':
    case 'pptx':
      return Icons.slideshow_outlined;
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'gif':
    case 'svg':
      return Icons.image_outlined;
    case 'mp3':
    case 'wav':
    case 'm4a':
      return Icons.audiotrack_outlined;
    case 'mp4':
    case 'mov':
      return Icons.videocam_outlined;
    case 'zip':
      return Icons.folder_zip_outlined;
    default:
      return Icons.insert_drive_file_outlined;
  }
}
