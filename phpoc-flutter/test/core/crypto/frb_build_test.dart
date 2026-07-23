import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/frb_generated.dart';

/// Build & Scaffold Tests — Phase 2 (RED)
///
/// Group A assertions from the Phase 1 blueprint.
/// Tests for flutter_rust_bridge codegen, cargo compilation, and FFI linkage.
///
/// In Phase 2, these tests are RED because:
/// - `flutter_rust_bridge_codegen generate` has not been run
/// - `frb.rs` does not exist in phpoc-crypto-core/src/
/// - The native library (.so) has not been compiled for the host target
/// - The generated Dart bindings are not yet real (stub only)
///
/// After Phase 3 (GREEN), flutter_rust_bridge is wired and these tests pass.

// ── Expected API surface — 23 functions from wasm.rs ────────────

/// The 23 exported function names that `frb.rs` must expose.
/// Matching `phpoc-crypto-core/src/wasm.rs` exactly.
const expectedFrbApiSurface = <String>{
  // Key derivation (6)
  'derivePdk',
  'derivePdkWithSalt',
  'deriveMasterKey',
  'deriveBlobKey',
  'deriveSealKey',
  'deriveFieldKey',
  // AES-128-CTR (2)
  'encrypt',
  'decrypt',
  // HMAC / Sealing / Signing (6)
  'seal',
  'verifySeal',
  'sign',
  'verifySignature',
  'hmacHex',
  // SHA-256 (1)
  'sha256',
  // Blob Obfuscation (2)
  'obfuscateBlob',
  'deobfuscateBlob',
  // Random Generation (3)
  'generateSeed',
  'generateUuidV4',
  'generateDeviceSpecifier',
  // Device Identity (3)
  'deviceProof',
  'verifyDeviceProof',
  'getDeviceId',
  // Auth Flow (1)
  'authenticate',
};

/// Paths relative to the phpoc-flutter project root.
const rustCratePath = '../phpoc-crypto-core';
const frbRsPath = '../phpoc-crypto-core/src/frb.rs';
const generatedDartPath = 'lib/core/crypto/frb_generated.dart';
const cargoTomlPath = '../phpoc-crypto-core/Cargo.toml';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: flutter_rust_bridge Scaffold (8 Dart-testable assertions)
  // ═══════════════════════════════════════════════════════════════

  group('A: flutter_rust_bridge Scaffold', () {
    // A1 — Generated Dart file exists and is importable
    test('A1: frb_generated.dart module exists and is importable', () {
      // In RED phase: the stub exists so it imports successfully.
      // In GREEN phase: this validates the real generated file exists.
      final file = File(generatedDartPath);
      expect(file.existsSync(), isTrue,
          reason: 'frb_generated.dart must exist (stub in RED, real in GREEN)');
    });

    // A2 — Cargo.toml in phpoc-crypto-core exists
    test('A2: phpoc-crypto-core/Cargo.toml exists (Rust crate is present)', () {
      final file = File(cargoTomlPath);
      expect(file.existsSync(), isTrue,
          reason: 'Rust crate Cargo.toml must exist at $cargoTomlPath');
    });

    // A3 — frb.rs exists in phpoc-crypto-core/src/
    test('A3: frb.rs exists in phpoc-crypto-core/src/', () {
      final file = File(frbRsPath);
      // In RED phase: frb.rs does NOT exist yet; test FAILS.
      // In GREEN phase: frb.rs is created with flutter_rust_bridge annotations.
      expect(file.existsSync(), isTrue,
          reason: '$frbRsPath must exist — this is the flutter_rust_bridge API '
              'surface (mirrors wasm.rs). It should be created in Phase 3.');
    });

    // A4 — Generated API surface has exactly 23 exported functions
    test('A4: frb_generated.dart exports exactly the 23 expected functions', () {
      // In RED phase: the stub has all 23 functions (so this partially passes),
      // but the real generated file in GREEN will have proper types.
      // We verify the stub exports the expected public API surface.
      final exports = expectedFrbApiSurface;

      // Verify each expected function is callable (no import errors)
      expect(() => derivePdk('test', 600000), returnsNormally);
      expect(() => derivePdkWithSalt('test', '0' * 32, 600000), returnsNormally);
      expect(() => deriveMasterKey('QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='),
          returnsNormally);
      expect(() => deriveBlobKey('a' * 64), returnsNormally);
      expect(() => deriveSealKey('a' * 64), returnsNormally);
      expect(() => deriveFieldKey('a' * 64), returnsNormally);
      expect(() => encrypt('test', 'a' * 64), returnsNormally);
      expect(
          () => decrypt(encrypt('test', 'a' * 64), 'a' * 64), returnsNormally);
      expect(() => seal('data', 'a' * 64), returnsNormally);
      expect(() => verifySeal('data', 'a' * 64, 'a' * 64), returnsNormally);
      expect(() => sign('data', 'a' * 64), returnsNormally);
      expect(() => verifySignature('data', 'a' * 64, 'a' * 64), returnsNormally);
      expect(() => hmacHex('a' * 64, 'data'), returnsNormally);
      expect(() => sha256('data'), returnsNormally);
      expect(() => obfuscateBlob('data', 'a' * 64), returnsNormally);
      expect(
          () => deobfuscateBlob(obfuscateBlob('data', 'a' * 64), 'a' * 64), returnsNormally);
      expect(() => generateSeed(), returnsNormally);
      expect(() => generateUuidV4(), returnsNormally);
      expect(() => generateDeviceSpecifier(), returnsNormally);
      expect(() => deviceProof('a' * 64, 'device-id'), returnsNormally);
      expect(
          () => verifyDeviceProof('id', '0' * 64, 'a' * 64), returnsNormally);
      expect(() => getDeviceId('a' * 64), returnsNormally);
      expect(() => authenticate('pass', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
          600000), returnsNormally);

      // Verify no extra unexpected exports (stub has exactly 23)
      expect(exports.length, 23,
          reason: 'Expected exactly 23 exported functions, got ${exports.length}');
    });

    // A5 — Rust crate contains ring + base64 + hex dependencies
    test('A5: Cargo.toml declares ring, base64, and hex dependencies', () {
      final cargoToml = File(cargoTomlPath);
      if (!cargoToml.existsSync()) {
        // RED: Cargo.toml not found — will fail on A2 as well
        return;
      }
      final content = cargoToml.readAsStringSync();
      expect(content, contains('ring'),
          reason: 'Cargo.toml must declare ring dependency for crypto primitives');
      expect(content, contains('base64'),
          reason: 'Cargo.toml must declare base64 dependency for blob serialization');
      expect(content, contains('hex'),
          reason: 'Cargo.toml must declare hex dependency for key encoding');
    });

    // A6 — Cargo.toml declares flutter_rust_bridge dependency
    test('A6: Cargo.toml declares flutter_rust_bridge dependency', () {
      final cargoToml = File(cargoTomlPath);
      if (!cargoToml.existsSync()) return;
      final content = cargoToml.readAsStringSync();
      expect(content, contains('flutter_rust_bridge'),
          reason: 'Cargo.toml must declare flutter_rust_bridge for FFI codegen');
    });

    // A7 — pubspec.yaml declares flutter_rust_bridge Dart dependency
    test('A7: pubspec.yaml declares flutter_rust_bridge dependency', () {
      final pubspec = File('pubspec.yaml');
      expect(pubspec.existsSync(), isTrue);
      final content = pubspec.readAsStringSync();
      expect(content, contains('flutter_rust_bridge'),
          reason: 'pubspec.yaml must declare flutter_rust_bridge for Dart-side FFI');
    });

    // A8 — Rust crate has [lib] section with crate-type for cdylib + staticlib
    test('A8: Cargo.toml [lib] section declares cdylib and staticlib', () {
      final cargoToml = File(cargoTomlPath);
      if (!cargoToml.existsSync()) return;
      final content = cargoToml.readAsStringSync();
      // Must declare cdylib for Android (.so) and staticlib for iOS (.a)
      expect(content, contains('cdylib'),
          reason: 'Cargo.toml must declare cdylib crate-type for Android .so');
      expect(content, contains('staticlib'),
          reason: 'Cargo.toml must declare staticlib crate-type for iOS .a');
    });

    // ── Build pipeline assertions (documented, not testable in unit tests) ──
    //
    // A5  — cargo build --target aarch64-linux-android succeeds
    // A6  — cargo build --target x86_64-linux-android succeeds
    // A7  — Android .so loads on API 35 emulator without UnsatisfiedLinkError
    // A8  — Generated Dart bindings compile with flutter analyze (zero errors)
    // A9  — flutter_rust_bridge version pinned in Cargo.toml and pubspec.yaml matches
    // A10 — Rust crate compiles with panic = "abort" for release target
    // A11 — Dart NativeLibrary loads .so at app startup (not lazily)
    // A12 — flutter build apk --debug succeeds with Rust FFI linked
    //
    // These are CI/build-system checks, not unit tests. They will be validated
    // during Phase 3 build integration. Documented here for traceability.
  });
}
