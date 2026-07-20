import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/crypto/crypto_service.dart';

/// Singleton crypto service — initialized once at boot.
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  return CryptoService();
});
