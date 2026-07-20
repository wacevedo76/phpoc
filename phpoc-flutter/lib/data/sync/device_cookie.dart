import '../../core/models/device_cookie.dart';

/// Device cookie creation and validation.
///
/// Port of web src/sync/cookie.js.
///
/// TODO: Full implementation — currently stub.
class DeviceCookieManager {
  /// Create a new device cookie for the current session.
  DeviceCookie create(String deviceUuid, String deviceSpecifier) {
    return DeviceCookie(
      deviceUuid: deviceUuid,
      deviceSpecifier: deviceSpecifier,
      creationTime: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    );
  }

  /// Check if two cookies match (same device session).
  bool matches(DeviceCookie a, DeviceCookie b) {
    return a.deviceUuid == b.deviceUuid &&
        a.deviceSpecifier == b.deviceSpecifier;
  }
}
