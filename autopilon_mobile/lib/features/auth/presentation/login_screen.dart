import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _rememberMe = true;
  bool _obscure = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Surfaces AuthController's own error (e.g. "Your session expired —
    // please log in again," set when a 401 on an authenticated request
    // redirects here — see auth_provider.dart's onSessionExpired
    // listener), not just errors from a login attempt made on this screen.
    _error = ref.read(authControllerProvider).error;
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _submitting = true; _error = null; });
    final ok = await ref.read(authControllerProvider.notifier).login(_email.text.trim(), _password.text, rememberMe: _rememberMe);
    if (!mounted) return;
    setState(() => _submitting = false);
    if (!ok) setState(() => _error = ref.read(authControllerProvider).error ?? 'Login failed.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Autopilon', style: Theme.of(context).textTheme.displaySmall),
                  const SizedBox(height: 6),
                  Text('Sign in to manage your business', style: Theme.of(context).textTheme.bodyMedium),
                  const SizedBox(height: 32),
                  TextFormField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'Email'),
                    validator: (v) => (v == null || !v.contains('@')) ? 'Enter a valid email' : null,
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _password,
                    obscureText: _obscure,
                    decoration: InputDecoration(
                      labelText: 'Password',
                      suffixIcon: IconButton(
                        icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                    ),
                    validator: (v) => (v == null || v.isEmpty) ? 'Enter your password' : null,
                  ),
                  Row(
                    children: [
                      Checkbox(value: _rememberMe, onChanged: (v) => setState(() => _rememberMe = v ?? true)),
                      const Text('Remember me'),
                      const Spacer(),
                      TextButton(
                        onPressed: () => context.push('/forgot-password'),
                        child: const Text('Forgot password?'),
                      ),
                    ],
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 4),
                    Text(_error!, style: const TextStyle(color: Colors.red)),
                  ],
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: _submitting ? null : _submit,
                    child: _submitting
                        ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Log in'),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Text("Don't have an account?"),
                      TextButton(onPressed: () => context.push('/signup'), child: const Text('Sign up')),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
