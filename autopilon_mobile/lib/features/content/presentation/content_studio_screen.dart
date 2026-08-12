import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../providers/content_provider.dart';
import 'content_actions_sheet.dart';
import 'content_create_sheet.dart';

const _tabDefs = [
  (ContentFilter.all, 'All', Icons.grid_view_outlined),
  (ContentFilter.images, 'Images', Icons.image_outlined),
  (ContentFilter.copy, 'Copy', Icons.edit_note_outlined),
  (ContentFilter.voiceovers, 'Voiceovers', Icons.mic_none_outlined),
  (ContentFilter.favorites, 'Favorites', Icons.star_outline),
];

class ContentStudioScreen extends ConsumerWidget {
  const ContentStudioScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(contentControllerProvider);
    final controller = ref.read(contentControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Content Studio')),
      body: Column(
        children: [
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: _tabDefs.map((t) {
                final active = state.filter == t.$1;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                  child: ChoiceChip(
                    label: Text(t.$2),
                    avatar: Icon(t.$3, size: 16),
                    selected: active,
                    onSelected: (_) => controller.setFilter(t.$1),
                  ),
                );
              }).toList(),
            ),
          ),
          Expanded(child: _buildBody(context, ref, state, controller)),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => showContentCreateSheet(context, ref),
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildBody(BuildContext context, WidgetRef ref, ContentState state, ContentController controller) {
    if (state.loading) return const Center(child: CircularProgressIndicator());
    if (state.assets.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.auto_awesome, size: 48, color: Colors.grey),
              const SizedBox(height: 12),
              Text('No content yet', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 4),
              const Text('Tap + to generate an image, caption, or voiceover.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: controller.load,
      child: ListView(
        children: state.assets
            .map((asset) => ListTile(
                  leading: Icon(_iconFor(asset.contentType), color: Colors.grey[600]),
                  title: Text(asset.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(asset.contentType.replaceAll('_', ' ')),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (asset.status == 'failed') const Icon(Icons.error_outline, color: Colors.red, size: 18),
                    if (asset.favorite) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.star, color: Colors.amber, size: 18)),
                  ]),
                  onTap: () => showContentActionsSheet(context, ref, asset),
                ))
            .toList(),
      ),
    );
  }
}

IconData _iconFor(String contentType) {
  switch (contentType) {
    case 'image':
      return Icons.image_outlined;
    case 'voiceover':
    case 'audio':
    case 'music':
      return Icons.mic_none_outlined;
    case 'video':
      return Icons.videocam_outlined;
    default:
      return Icons.edit_note_outlined;
  }
}
