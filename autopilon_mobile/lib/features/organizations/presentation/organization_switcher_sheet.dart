import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../providers/organization_provider.dart';

/// Call `showOrganizationSwitcher(context)` from anywhere (e.g. an app-bar
/// tap target) to let the user switch between Personal mode and any
/// organization they belong to — same "Personal (no organization)" +
/// per-org list pattern as the web client's Organizations page.
Future<void> showOrganizationSwitcher(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => const _OrganizationSwitcherSheet(),
  );
}

class _OrganizationSwitcherSheet extends ConsumerWidget {
  const _OrganizationSwitcherSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orgState = ref.watch(organizationControllerProvider);
    final controller = ref.read(organizationControllerProvider.notifier);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Switch context', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('Personal (no organization)'),
              trailing: orgState.activeOrgId == null ? const Icon(Icons.check, color: Colors.green) : null,
              onTap: () async {
                await controller.switchTo(null);
                if (context.mounted) Navigator.pop(context);
              },
            ),
            const Divider(),
            if (orgState.loading) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())),
            ...orgState.organizations.map((org) => ListTile(
                  leading: const Icon(Icons.apartment_outlined),
                  title: Text(org.name),
                  subtitle: Text(org.myRole),
                  trailing: orgState.activeOrgId == org.id ? const Icon(Icons.check, color: Colors.green) : null,
                  onTap: () async {
                    await controller.switchTo(org.id);
                    if (context.mounted) Navigator.pop(context);
                  },
                )),
            if (!orgState.loading && orgState.organizations.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text("You're not part of any organization yet."),
              ),
          ],
        ),
      ),
    );
  }
}
