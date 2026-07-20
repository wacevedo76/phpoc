import 'package:equatable/equatable.dart';

/// Device cookie — auth gate mechanism for staging sync.
///
/// Mirrors the Python `DeviceCookie` and JS `DeviceCookie` classes.
class DeviceCookie extends Equatable {
  final String deviceUuid;
  final String deviceSpecifier;
  final int creationTime; // epoch seconds

  const DeviceCookie({
    required this.deviceUuid,
    required this.deviceSpecifier,
    required this.creationTime,
  });

  /// Check if this cookie is still valid (not expired).
  bool isValid(int ttlSeconds) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    return (now - creationTime) < ttlSeconds;
  }

  /// Serialize to JSON for storage/transport.
  Map<String, dynamic> toJson() => {
        'device_uuid': deviceUuid,
        'device_specifier': deviceSpecifier,
        'creation_time': creationTime,
      };

  factory DeviceCookie.fromJson(Map<String, dynamic> json) => DeviceCookie(
        deviceUuid: json['device_uuid'] as String,
        deviceSpecifier: json['device_specifier'] as String,
        creationTime: json['creation_time'] as int,
      );

  @override
  List<Object?> get props => [deviceUuid, deviceSpecifier, creationTime];
}
