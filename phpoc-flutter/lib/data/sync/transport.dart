/// HTTP transport for remote staging blob and ledger block I/O.
///
/// Port of web src/sync/transport.js HttpTransport.
/// Wire protocol is identical — same Cloudflare Worker, same paths,
/// same ETag semantics.
///
/// TODO: Full implementation — currently stub.
class HttpTransport {
  final String baseUrl;
  final String apiKey;

  HttpTransport({required this.baseUrl, required this.apiKey});

  // Future<Uint8List?> pull(String path);
  // Future<void> push(String path, Uint8List data);
  // Future<List<String>> listFiles(String prefix);
  // Future<void> delete(String path);
}
