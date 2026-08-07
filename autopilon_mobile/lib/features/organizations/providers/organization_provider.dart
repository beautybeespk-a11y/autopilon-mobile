import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/models/models.dart';
import '../../../core/storage/secure_storage.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/organization_repository.dart';

final organizationRepositoryProvider = Provider<OrganizationRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return OrganizationRepository(apiClientAsync.requireValue);
});

class OrgState {
  final List<Organization> organizations;
  final String? activeOrgId; // null = "Personal" mode, same convention as the web client
  final bool loading;
  const OrgState({this.organizations = const [], this.activeOrgId, this.loading = true});

  OrgState copyWith({List<Organization>? organizations, String? activeOrgId, bool clearActive = false, bool? loading}) => OrgState(
        organizations: organizations ?? this.organizations,
        activeOrgId: clearActive ? null : (activeOrgId ?? this.activeOrgId),
        loading: loading ?? this.loading,
      );
}

/// Mirrors the web client's org-switching model exactly: null active org
/// means "Personal" mode, switching persists server-side (so it survives
/// across devices/sessions the same way), and this provider just reflects
/// that plus caches it locally for a snappier first paint.
class OrganizationController extends StateNotifier<OrgState> {
  OrganizationController(this._ref) : super(const OrgState()) {
    _load();
  }
  final Ref _ref;

  Future<void> _load() async {
    final repo = _ref.read(organizationRepositoryProvider);
    final orgsResult = await repo.list();
    final currentResult = await repo.current();
    state = OrgState(
      organizations: orgsResult.data ?? [],
      activeOrgId: currentResult.data,
      loading: false,
    );
    if (currentResult.data != null) await SecureStorage.setActiveOrgId(currentResult.data);
  }

  Future<void> switchTo(String? orgId) async {
    final repo = _ref.read(organizationRepositoryProvider);
    final result = await repo.switchTo(orgId);
    if (result.isSuccess) {
      state = orgId == null ? state.copyWith(clearActive: true) : state.copyWith(activeOrgId: orgId);
      await SecureStorage.setActiveOrgId(orgId);
    }
  }

  Future<void> refresh() => _load();
}

final organizationControllerProvider = StateNotifierProvider<OrganizationController, OrgState>((ref) => OrganizationController(ref));
