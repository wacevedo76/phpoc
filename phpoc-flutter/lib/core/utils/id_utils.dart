/// Generate a 10-character alphanumeric activity_id for staging entries
/// that don't have a valid PHPSPEC entry_id.
String generateActivityId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  final buf = StringBuffer();
  for (var i = 0; i < 10; i++) {
    buf.write(chars[(DateTime.now().microsecondsSinceEpoch + i * 7919) % chars.length]);
  }
  return buf.toString();
}
