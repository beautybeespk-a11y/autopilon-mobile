import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../data/marketplace_models.dart';
import '../providers/marketplace_provider.dart';

class MarketplaceAssetDetailScreen extends ConsumerStatefulWidget {
  const MarketplaceAssetDetailScreen({super.key, required this.assetId});
  final String assetId;

  @override
  ConsumerState<MarketplaceAssetDetailScreen> createState() => _MarketplaceAssetDetailScreenState();
}

class _MarketplaceAssetDetailScreenState extends ConsumerState<MarketplaceAssetDetailScreen> {
  int _draftRating = 5;
  final _reviewCtrl = TextEditingController();

  @override
  void dispose() {
    _reviewCtrl.dispose();
    super.dispose();
  }

  Future<void> _installOrBuy(AssetDetailController controller) async {
    final checkoutUrl = await controller.installOrBuy();
    if (checkoutUrl == null) return;
    final uri = Uri.tryParse(checkoutUrl);
    if (uri != null) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(assetDetailControllerProvider(widget.assetId));
    final controller = ref.read(assetDetailControllerProvider(widget.assetId).notifier);
    final asset = state.asset;

    return Scaffold(
      appBar: AppBar(title: Text(asset?.name ?? 'Listing')),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : state.error != null
              ? Center(child: Text(state.error!, style: const TextStyle(color: Colors.red)))
              : asset == null
                  ? const SizedBox.shrink()
                  : RefreshIndicator(
                      onRefresh: controller.load,
                      child: ListView(
                        padding: const EdgeInsets.all(16),
                        children: [
                          Text(asset.name, style: Theme.of(context).textTheme.titleLarge),
                          const SizedBox(height: 4),
                          Wrap(
                            spacing: 6,
                            children: [
                              Chip(
                                label: Text(asset.assetType, style: const TextStyle(fontSize: 11)),
                                visualDensity: VisualDensity.compact,
                              ),
                              if (asset.license != null)
                                Chip(
                                  label: Text(asset.license!, style: const TextStyle(fontSize: 11)),
                                  visualDensity: VisualDensity.compact,
                                ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Text(asset.description),
                          if (asset.tags.isNotEmpty) ...[
                            const SizedBox(height: 12),
                            Wrap(
                              spacing: 6,
                              runSpacing: 6,
                              children: asset.tags
                                  .map((t) => Chip(label: Text(t, style: const TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact))
                                  .toList(),
                            ),
                          ],
                          const SizedBox(height: 16),
                          Row(
                            children: [
                              _Stat(label: 'Installs', value: '${asset.downloadCount}'),
                              const SizedBox(width: 20),
                              _Stat(label: 'Rating', value: asset.ratingCount == 0 ? '—' : '${asset.avgRating.toStringAsFixed(1)} (${asset.ratingCount})'),
                              const SizedBox(width: 20),
                              _Stat(label: 'Version', value: asset.latestVersion?.version ?? '—'),
                            ],
                          ),
                          const SizedBox(height: 20),
                          SizedBox(
                            width: double.infinity,
                            child: FilledButton(
                              onPressed: state.actionBusy ? null : () => _installOrBuy(controller),
                              child: state.actionBusy
                                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                  : Text(asset.isFree ? 'Install' : 'Buy — \$${(asset.priceCents / 100).toStringAsFixed(2)}'),
                            ),
                          ),
                          if (state.actionMessage != null) ...[
                            const SizedBox(height: 8),
                            Text(state.actionMessage!, style: TextStyle(color: Theme.of(context).colorScheme.primary, fontSize: 13)),
                          ],
                          const SizedBox(height: 24),
                          const Divider(),
                          const SizedBox(height: 12),
                          Text('Leave a review', style: Theme.of(context).textTheme.titleMedium),
                          const SizedBox(height: 8),
                          Row(
                            children: List.generate(
                              5,
                              (i) => IconButton(
                                padding: EdgeInsets.zero,
                                constraints: const BoxConstraints(),
                                icon: Icon(i < _draftRating ? Icons.star : Icons.star_border, color: Colors.amber),
                                onPressed: () => setState(() => _draftRating = i + 1),
                              ),
                            ),
                          ),
                          TextField(
                            controller: _reviewCtrl,
                            minLines: 2,
                            maxLines: 4,
                            decoration: const InputDecoration(hintText: 'What did you think?', isDense: true),
                          ),
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.centerRight,
                            child: OutlinedButton(
                              onPressed: state.actionBusy
                                  ? null
                                  : () {
                                      controller.submitReview(_draftRating, _reviewCtrl.text.trim());
                                      _reviewCtrl.clear();
                                    },
                              child: const Text('Submit review'),
                            ),
                          ),
                          const SizedBox(height: 20),
                          Text('Reviews (${state.reviews.length})', style: Theme.of(context).textTheme.titleMedium),
                          const SizedBox(height: 8),
                          if (state.reviews.isEmpty)
                            const Text('No reviews yet.', style: TextStyle(color: Colors.grey))
                          else
                            ...state.reviews.map((r) => _ReviewTile(review: r, onHelpful: () => controller.voteHelpful(r.id))),
                          const SizedBox(height: 24),
                        ],
                      ),
                    ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
      ],
    );
  }
}

class _ReviewTile extends StatelessWidget {
  const _ReviewTile({required this.review, required this.onHelpful});
  final MarketplaceReview review;
  final VoidCallback onHelpful;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(border: Border.all(color: Colors.grey.withOpacity(0.25)), borderRadius: BorderRadius.circular(10)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(review.userName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(width: 8),
              Row(children: List.generate(5, (i) => Icon(i < review.rating ? Icons.star : Icons.star_border, size: 12, color: Colors.amber))),
              if (review.verifiedInstall) ...[
                const SizedBox(width: 6),
                const Text('Verified', style: TextStyle(fontSize: 10, color: Colors.green)),
              ],
            ],
          ),
          if (review.reviewText?.isNotEmpty == true) ...[
            const SizedBox(height: 6),
            Text(review.reviewText!, style: const TextStyle(fontSize: 13)),
          ],
          if (review.developerReply?.isNotEmpty == true) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(8)),
              child: Text('Developer reply: ${review.developerReply}', style: const TextStyle(fontSize: 12)),
            ),
          ],
          const SizedBox(height: 4),
          TextButton.icon(
            onPressed: onHelpful,
            icon: const Icon(Icons.thumb_up_outlined, size: 14),
            label: Text('Helpful (${review.helpfulCount})', style: const TextStyle(fontSize: 12)),
            style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 0), tapTargetSize: MaterialTapTargetSize.shrinkWrap),
          ),
        ],
      ),
    );
  }
}
