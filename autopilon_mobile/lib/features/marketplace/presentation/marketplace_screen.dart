import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../data/marketplace_models.dart';
import '../providers/marketplace_provider.dart';

const _typeLabels = {
  'agent': 'Agents',
  'automation': 'Automations',
  'prompt': 'Prompts',
  'knowledge_pack': 'Knowledge packs',
};

const _typeIcons = {
  'agent': Icons.smart_toy_outlined,
  'automation': Icons.bolt_outlined,
  'prompt': Icons.chat_bubble_outline,
  'knowledge_pack': Icons.menu_book_outlined,
};

class MarketplaceScreen extends ConsumerStatefulWidget {
  const MarketplaceScreen({super.key});
  @override
  ConsumerState<MarketplaceScreen> createState() => _MarketplaceScreenState();
}

class _MarketplaceScreenState extends ConsumerState<MarketplaceScreen> {
  final _searchCtrl = TextEditingController();

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(marketplaceBrowseControllerProvider);
    final controller = ref.read(marketplaceBrowseControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Marketplace'),
        actions: [
          IconButton(
            icon: const Icon(Icons.inventory_2_outlined),
            tooltip: 'My installs',
            onPressed: () => context.push('/more/marketplace/installs'),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: TextField(
              controller: _searchCtrl,
              decoration: const InputDecoration(
                hintText: 'Search agents, automations, prompts…',
                prefixIcon: Icon(Icons.search, size: 20),
                isDense: true,
              ),
              onSubmitted: controller.search,
            ),
          ),
          SizedBox(
            height: 40,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                _TypeChip(label: 'All', selected: state.type == null, onTap: () => controller.filterByType(null)),
                ..._typeLabels.entries.map((e) => Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: _TypeChip(
                        label: e.value,
                        selected: state.type == e.key,
                        onTap: () => controller.filterByType(e.key),
                      ),
                    )),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: state.loading
                ? const Center(child: CircularProgressIndicator())
                : state.error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(state.error!, style: const TextStyle(color: Colors.red)),
                              const SizedBox(height: 12),
                              FilledButton(onPressed: () => controller.search(), child: const Text('Retry')),
                            ],
                          ),
                        ),
                      )
                    : state.assets.isEmpty
                        ? const Center(
                            child: Padding(
                              padding: EdgeInsets.all(24),
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.storefront_outlined, size: 48, color: Colors.grey),
                                  SizedBox(height: 8),
                                  Text('No listings found.', style: TextStyle(color: Colors.grey)),
                                ],
                              ),
                            ),
                          )
                        : RefreshIndicator(
                            onRefresh: () => controller.search(),
                            child: ListView.separated(
                              padding: const EdgeInsets.all(12),
                              itemCount: state.assets.length,
                              separatorBuilder: (_, __) => const SizedBox(height: 8),
                              itemBuilder: (context, i) => _AssetCard(asset: state.assets[i]),
                            ),
                          ),
          ),
        ],
      ),
    );
  }
}

class _TypeChip extends StatelessWidget {
  const _TypeChip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      selected: selected,
      onSelected: (_) => onTap(),
      visualDensity: VisualDensity.compact,
    );
  }
}

class _AssetCard extends StatelessWidget {
  const _AssetCard({required this.asset});
  final MarketplaceAsset asset;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => context.push('/more/marketplace/${asset.id}'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: Theme.of(context).colorScheme.primary.withOpacity(0.12),
                child: Icon(_typeIcons[asset.assetType] ?? Icons.extension_outlined,
                    color: Theme.of(context).colorScheme.primary, size: 18),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(asset.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(
                      asset.description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Text(
                          asset.isFree ? 'Free' : '\$${(asset.priceCents / 100).toStringAsFixed(2)}',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                        ),
                        const SizedBox(width: 10),
                        const Icon(Icons.download_outlined, size: 12, color: Colors.grey),
                        const SizedBox(width: 2),
                        Text('${asset.downloadCount}', style: const TextStyle(fontSize: 11, color: Colors.grey)),
                        if (asset.ratingCount > 0) ...[
                          const SizedBox(width: 10),
                          const Icon(Icons.star, size: 12, color: Colors.amber),
                          const SizedBox(width: 2),
                          Text(asset.avgRating.toStringAsFixed(1), style: const TextStyle(fontSize: 11, color: Colors.grey)),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
