import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../providers/auth_provider.dart';

class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});
  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _email = TextEditingController();
  String? _message;
  bool _submitting = false;

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty) return;
    setState(() => _submitting = true);
    final repo = ref.read(authRepositoryProvider);
    final result = await repo.forgotPassword(_email.text.trim());
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _message = result.isSuccess ? result.data : (result.error ?? 'Something went wrong.');
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text("Enter your account email and we'll send reset instructions."),
            const SizedBox(height: 16),
            TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
            if (_message != null) ...[
              const SizedBox(height: 14),
              Text(_message!, style: Theme.of(context).textTheme.bodyMedium),
            ],
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Send reset instructions'),
            ),
          ],
        ),
      ),
    );
  }
}
