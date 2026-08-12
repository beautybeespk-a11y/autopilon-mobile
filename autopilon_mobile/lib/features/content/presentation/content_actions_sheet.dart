import 'dart:io';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import '../data/content_models.dart';
import '../providers/content_provider.dart';

/// The bottom sheet opened by tapping a content asset — mirrors
/// file_actions_sheet.dart's shape (favorite/download-share/trash), plus a
/// preview appropriate to the asset's type. Regeneration and version
/// history stay web-only for this pass, same "lightweight, not a
/// desktop-editor copy" scoping the rest of mobile Content Studio follows.
void showContentActionsSheet(BuildContext context, WidgetRef ref, ContentAsset asset) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => _ContentActionsSheet(asset: asset),
  );
}

class _ContentActionsSheet extends ConsumerStatefulWidget {
  const _ContentActionsSheet({required this.asset});
  final ContentAsset asset;

  @override
  ConsumerState<_ContentActionsSheet> createState() => _ContentActionsSheetState();
}

class _ContentActionsSheetState extends ConsumerState<_ContentActionsSheet> {
  bool _busy = false;
  String? _error;
  Uint8List? _bytes;
  bool _loadingBytes = false;
  final _player = AudioPlayer();
  bool _playing = false;

  bool get _isImage => widget.asset.contentType == 'image';
  bool get _isAudio => widget.asset.contentType == 'voiceover' || widget.asset.contentType == 'audio' || widget.asset.contentType == 'music';

  @override
  void initState() {
    super.initState();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    });
    if (widget.asset.fileId != null && (_isImage || _isAudio)) {
      _loadBytes();
    }
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _loadBytes() async {
    setState(() => _loadingBytes = true);
    final result = await ref.read(contentRepositoryProvider).fetchFileBytes(widget.asset.fileId!);
    if (!mounted) return;
    setState(() { _bytes = result.data; _loadingBytes = false; });
  }

  Future<void> _togglePlay() async {
    if (_bytes == null) return;
    if (_playing) {
      await _player.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    await _player.play(BytesSource(_bytes!, mimeType: 'audio/mpeg'));
    if (mounted) setState(() => _playing = true);
  }

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

  Future<void> _shareOrExport() async {
    if (widget.asset.fileId != null) {
      final bytes = _bytes ?? (await ref.read(contentRepositoryProvider).fetchFileBytes(widget.asset.fileId!)).data;
      if (bytes == null) throw Exception('Could not download this asset.');
      final ext = _isImage ? 'png' : 'mp3';
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/${widget.asset.title.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_')}.$ext';
      final f = File(path);
      await f.writeAsBytes(bytes);
      if (mounted) Navigator.pop(context);
      await SharePlus.instance.share(ShareParams(files: [XFile(path)], text: widget.asset.title));
    } else if (widget.asset.textContent != null) {
      if (mounted) Navigator.pop(context);
      await SharePlus.instance.share(ShareParams(text: widget.asset.textContent!, subject: widget.asset.title));
    }
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Move to Trash?'),
        content: Text('"${widget.asset.title}" will be moved to Trash.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Delete')),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run(() async {
      final result = await ref.read(contentControllerProvider.notifier).trashAsset(widget.asset);
      if (!result.isSuccess) throw Exception(result.error);
    });
  }

  @override
  Widget build(BuildContext context) {
    final asset = widget.asset;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(asset.title, style: Theme.of(context).textTheme.titleMedium, maxLines: 2, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 4),
              Row(children: [
                _StatusChip(status: asset.status),
                const SizedBox(width: 8),
                Text('v${asset.currentVersion}', style: const TextStyle(color: Colors.grey, fontSize: 12)),
              ]),
              if (asset.status == 'failed' && asset.errorMessage != null) ...[
                const SizedBox(height: 8),
                Text(asset.errorMessage!, style: const TextStyle(color: Colors.red, fontSize: 12)),
              ],
              const SizedBox(height: 12),
              _buildPreview(),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
              ],
              const Divider(height: 24),
              if (_busy)
                const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: CircularProgressIndicator()))
              else ...[
                ListTile(
                  leading: Icon(asset.favorite ? Icons.star : Icons.star_border, color: asset.favorite ? Colors.amber : null),
                  title: Text(asset.favorite ? 'Remove from Favorites' : 'Add to Favorites'),
                  onTap: () => _run(() => ref.read(contentControllerProvider.notifier).toggleFavorite(asset)),
                ),
                ListTile(
                  leading: const Icon(Icons.copy_outlined),
                  title: const Text('Duplicate'),
                  onTap: () => _run(() async {
                    final result = await ref.read(contentControllerProvider.notifier).duplicateAsset(asset);
                    if (!result.isSuccess) throw Exception(result.error);
                  }),
                ),
                if (asset.fileId != null || asset.textContent != null)
                  ListTile(leading: const Icon(Icons.share_outlined), title: const Text('Share / Export'), onTap: () => _run(_shareOrExport)),
                ListTile(leading: const Icon(Icons.delete_outline, color: Colors.red), title: const Text('Move to Trash', style: TextStyle(color: Colors.red)), onTap: _confirmDelete),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPreview() {
    final asset = widget.asset;
    if (_isImage) {
      if (_loadingBytes) return const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()));
      if (_bytes == null) return const SizedBox.shrink();
      return ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.memory(_bytes!, fit: BoxFit.contain));
    }
    if (_isAudio) {
      if (_loadingBytes) return const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: LinearProgressIndicator());
      if (_bytes == null) return const SizedBox.shrink();
      return Row(children: [
        IconButton.filled(icon: Icon(_playing ? Icons.stop : Icons.play_arrow), onPressed: _togglePlay),
        const SizedBox(width: 8),
        const Text('Voiceover'),
      ]);
    }
    if (asset.textContent != null) {
      return Container(
        width: double.infinity,
        constraints: const BoxConstraints(maxHeight: 240),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: Colors.grey.withOpacity(0.1), borderRadius: BorderRadius.circular(12)),
        child: SingleChildScrollView(child: Text(asset.textContent!)),
      );
    }
    return const SizedBox.shrink();
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final color = status == 'ready' ? Colors.green : (status == 'failed' ? Colors.red : Colors.grey);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: color.withOpacity(0.15), borderRadius: BorderRadius.circular(8)),
      child: Text(status, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
    );
  }
}
