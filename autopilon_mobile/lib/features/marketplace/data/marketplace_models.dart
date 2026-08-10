class MarketplaceAsset {
  final String id;
  final String assetType; // agent | automation | prompt | knowledge_pack
  final String name;
  final String description;
  final String pricingType; // free | paid
  final int priceCents;
  final int downloadCount;
  final int ratingCount;
  final double ratingSum;
  final String? category;

  MarketplaceAsset({
    required this.id,
    required this.assetType,
    required this.name,
    required this.description,
    required this.pricingType,
    required this.priceCents,
    required this.downloadCount,
    required this.ratingCount,
    required this.ratingSum,
    this.category,
  });

  double get avgRating => ratingCount == 0 ? 0 : ratingSum / ratingCount;
  bool get isFree => pricingType != 'paid' || priceCents == 0;

  factory MarketplaceAsset.fromJson(Map<String, dynamic> json) => MarketplaceAsset(
        id: json['id']?.toString() ?? '',
        assetType: json['assetType'] ?? 'agent',
        name: json['name'] ?? '',
        description: json['description'] ?? '',
        pricingType: json['pricingType'] ?? 'free',
        priceCents: json['priceCents'] ?? 0,
        downloadCount: json['downloadCount'] ?? 0,
        ratingCount: json['ratingCount'] ?? 0,
        ratingSum: (json['ratingSum'] as num?)?.toDouble() ?? 0,
        category: json['category'],
      );
}

class MarketplaceCategory {
  final String id;
  final String name;
  MarketplaceCategory({required this.id, required this.name});
  factory MarketplaceCategory.fromJson(Map<String, dynamic> json) => MarketplaceCategory(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
      );
}

class AssetVersion {
  final String version;
  final String? releaseNotes;
  AssetVersion({required this.version, this.releaseNotes});
  factory AssetVersion.fromJson(Map<String, dynamic> json) => AssetVersion(
        version: json['version']?.toString() ?? '',
        releaseNotes: json['releaseNotes'],
      );
}

class MarketplaceAssetDetail extends MarketplaceAsset {
  final List<String> tags;
  final String status;
  final String? moderationStatus;
  final String? license;
  final AssetVersion? latestVersion;

  MarketplaceAssetDetail({
    required super.id,
    required super.assetType,
    required super.name,
    required super.description,
    required super.pricingType,
    required super.priceCents,
    required super.downloadCount,
    required super.ratingCount,
    required super.ratingSum,
    super.category,
    required this.tags,
    required this.status,
    this.moderationStatus,
    this.license,
    this.latestVersion,
  });

  factory MarketplaceAssetDetail.fromJson(Map<String, dynamic> json) => MarketplaceAssetDetail(
        id: json['id']?.toString() ?? '',
        assetType: json['assetType'] ?? 'agent',
        name: json['name'] ?? '',
        description: json['description'] ?? '',
        pricingType: json['pricingType'] ?? 'free',
        priceCents: json['priceCents'] ?? 0,
        downloadCount: json['downloadCount'] ?? 0,
        ratingCount: json['ratingCount'] ?? 0,
        ratingSum: (json['ratingSum'] as num?)?.toDouble() ?? 0,
        category: json['category'],
        tags: (json['tags'] as List? ?? []).map((t) => t.toString()).toList(),
        status: json['status'] ?? 'published',
        moderationStatus: json['moderationStatus'],
        license: json['license'],
        latestVersion: json['latestVersion'] != null
            ? AssetVersion.fromJson(json['latestVersion'] as Map<String, dynamic>)
            : null,
      );
}

class MarketplaceReview {
  final String id;
  final String userName;
  final int rating;
  final String? reviewText;
  final bool verifiedInstall;
  final int helpfulCount;
  final String? developerReply;

  MarketplaceReview({
    required this.id,
    required this.userName,
    required this.rating,
    this.reviewText,
    required this.verifiedInstall,
    required this.helpfulCount,
    this.developerReply,
  });

  factory MarketplaceReview.fromJson(Map<String, dynamic> json) => MarketplaceReview(
        id: json['id']?.toString() ?? '',
        userName: json['userName'] ?? 'Anonymous',
        rating: json['rating'] ?? 0,
        reviewText: json['reviewText'],
        verifiedInstall: json['verifiedInstall'] == true,
        helpfulCount: json['helpfulCount'] ?? 0,
        developerReply: json['developerReply'],
      );
}

class MarketplaceInstall {
  final String id;
  final String assetId;
  final String assetName;
  final String assetType;
  final String installedVersion;
  final String? latestVersion;
  final String status; // active | disabled | uninstalled

  MarketplaceInstall({
    required this.id,
    required this.assetId,
    required this.assetName,
    required this.assetType,
    required this.installedVersion,
    this.latestVersion,
    required this.status,
  });

  bool get updateAvailable => latestVersion != null && latestVersion != installedVersion;

  factory MarketplaceInstall.fromJson(Map<String, dynamic> json) => MarketplaceInstall(
        id: json['id']?.toString() ?? '',
        assetId: json['assetId']?.toString() ?? '',
        assetName: json['assetName'] ?? '',
        assetType: json['assetType'] ?? 'agent',
        installedVersion: json['installedVersion']?.toString() ?? '',
        latestVersion: json['latestVersion']?.toString(),
        status: json['status'] ?? 'active',
      );
}
