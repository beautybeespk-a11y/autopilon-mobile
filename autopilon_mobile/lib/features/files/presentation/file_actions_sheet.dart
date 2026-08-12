import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import '../data/file_models.dart';
import '../providers/files_provider.dart';

/// The bottom sheet opened by tapping a file — mirrors the web File
/// Manager's detail panel, scoped down to what's practical as a mobile
/// action sheet (rename/favorite/download-share/add-to-knowledge/trash).
/// Full version history and share-link management stay web-only for this
/// pass; both are already fully implemented server-side, so nothing here
/// is a permission gap — just UI not built yet on mobile.
void showFileActionsSheet(BuildContext context, WidgetRef ref, FileItem file) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => _FileActionsSheet(file: file),
  );
}

class _FileActionsSheet extends ConsumerStatefulWidget {
  const _FileActionsSheet({required this.file});
  final FileItem file;

  @override
  ConsumerState<_FileActionsSheet> createState() => _FileActionsSheetState();
}

class _FileActionsSheetState extends ConsumerState<_FileActionsSheet> {
  bool _busy = false;
  String? _error;

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; });
    try {
      await action();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() => _error = 'Something went wrong.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _downloadAndShare() async {
    final repo = ref.read(fileRepositoryProvider);
    final result = await repo.download(widget.file.id);
    if (!result.isSuccess || result.data == null) throw Exception(result.error);
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/${widget.file.filename}';
    final f = File(path);
    await f.writeAsBytes(result.data!);
    if (mounted) Navigator.pop(context);
    await SharePlus.instance.share(ShareParams(files: [XFile(path)], text: widget.file.filename));
  }

  Future<void> _rename() async {
    final controller = TextEditingController(text: widget.file.filename);
    final newName = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Rename'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, controller.text), child: const Text('Save')),
        ],
      ),
    );
    if (newName == null || newName.trim().isEmpty || newName == widget.file.filename) return;
    await _run(() async {
      final result = await ref.read(filesControllerProvider.notifier).rename(widget.file, newName.trim());
      if (!result.isSuccess) throw Exception(result.error);
    });
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Move to Trash?'),
        content: Text('"${widget.file.filename}" will be moved to Trash. You can restore it later.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Delete')),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run(() async {
      final result = await ref.read(filesControllerProvider.notifier).trashFile(widget.file);
      if (!result.isSuccess) throw Exception(result.error);
    });
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    final inTrash = file.status == 'trashed';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(file.filename, style: Theme.of(context).textTheme.titleMedium, maxLines: 2, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 4),
            Text('${(file.sizeBytes / 1024).toStringAsFixed(1)} KB · v${file.version}', style: const TextStyle(color: Colors.grey, fontSize: 12)),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ],
            const Divider(height: 24),
            if (_busy)
              const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: CircularProgressIndicator()))
            else if (inTrash) ...[
              ListTile(
                leading: const Icon(Icons.restore),
                title: const Text('Restore'),
                onTap: () => _run(() => ref.read(filesControllerProvider.notifier).restoreFile(file)),
              ),
              ListTile(
                leading: const Icon(Icons.delete_forever, color: Colors.red),
                title: const Text('Delete forever', style: TextStyle(color: Colors.red)),
                onTap: () => _run(() async {
                  final result = await ref.read(filesControllerProvider.notifier).permanentlyDelete(file);
                  if (!result.isSuccess) throw Exception(result.error);
                }),
              ),
            ] else ...[
              ListTile(
                leading: Icon(file.favorite ? Icons.star : Icons.star_border, color: file.favorite ? Colors.amber : null),
                title: Text(file.favorite ? 'Remove from Favorites' : 'Add to Favorites'),
                onTap: () => _run(() => ref.read(filesControllerProvider.notifier).toggleFavorite(file)),
              ),
              ListTile(leading: const Icon(Icons.drive_file_rename_outline), title: const Text('Rename'), onTap: _rename),
              ListTile(leading: const Icon(Icons.share_outlined), title: const Text('Download / Share'), onTap: () => _run(_downloadAndShare)),
              if (file.textExtractionSupport)
                ListTile(
                  leading: const Icon(Icons.menu_book_outlined),
                  title: const Text('Add to Knowledge Library'),
                  onTap: () => _run(() async {
                    final result = await ref.read(fileRepositoryProvider).addToKnowledge(file.id);
                    if (!result.isSuccess) throw Exception(result.error);
                  }),
                ),
              ListTile(leading: const Icon(Icons.delete_outline, color: Colors.red), title: const Text('Move to Trash', style: TextStyle(color: Colors.red)), onTap: _confirmDelete),
            ],
          ],
        ),
      ),
    );
  }
}
