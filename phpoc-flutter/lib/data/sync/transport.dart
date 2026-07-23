import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// HTTP transport for remote staging blob and ledger block I/O.
///
/// Port of web src/sync/transport.js HttpTransport.
/// Wire protocol is identical — same Cloudflare Worker, same paths,
/// same ETag semantics.
class HttpTransport {
  final String baseUrl;
  final String apiKey;

  /// Cached ETag values by path.
  final Map<String, String> _etags = {};

  /// Cached ETag for conditional GET (If-None-Match).
  final Map<String, String> _lastETags = {};

  HttpTransport({required this.baseUrl, required this.apiKey}) {
    if (baseUrl.isEmpty) {
      throw ArgumentError('baseUrl must not be empty');
    }
    final uri = Uri.tryParse(baseUrl);
    if (uri == null || (!uri.isScheme('http') && !uri.isScheme('https'))) {
      throw ArgumentError(
        'baseUrl must be an http:// or https:// URL, got: $baseUrl',
      );
    }
  }

  /// Build a full URL for a given path.
  Uri _url(String path) {
    return Uri.parse('$baseUrl/$path');
  }

  /// Pull raw bytes from a remote path.
  ///
  /// Returns the body as [Uint8List] on 200, null on 404.
  /// Throws on network errors or other non-2xx status codes.
  Future<Uint8List?> pull(String path) async {
    final uri = _url(path);
    final headers = <String, String>{
      'X-Api-Key': apiKey,
    };

    final etag = _lastETags[path];
    if (etag != null) {
      headers['If-None-Match'] = etag;
    }

    final response = await http.get(uri, headers: headers);

    if (response.statusCode == 304) {
      return null; // Not modified
    }
    if (response.statusCode == 404) {
      return null;
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      final etagHeader = response.headers['etag'];
      if (etagHeader != null) {
        _lastETags[path] = etagHeader;
      }
      return response.bodyBytes;
    }

    throw HttpTransportException(
      'HTTP ${response.statusCode} on pull($path)',
      response.statusCode,
    );
  }

  /// Push raw bytes to a remote path.
  ///
  /// Throws on non-2xx status codes.
  Future<void> push(String path, Uint8List data) async {
    final uri = _url(path);
    final headers = <String, String>{
      'X-Api-Key': apiKey,
      'Content-Type': 'application/octet-stream',
    };

    final etag = _etags[path];
    if (etag != null) {
      headers['If-Match'] = etag;
    }

    final response = await http.put(uri, headers: headers, body: data);

    if (response.statusCode >= 200 && response.statusCode < 300) {
      final etagHeader = response.headers['etag'];
      if (etagHeader != null) {
        _etags[path] = etagHeader;
      }
      return;
    }

    throw HttpTransportException(
      'HTTP ${response.statusCode} on push($path)',
      response.statusCode,
    );
  }

  /// List files under a remote prefix.
  ///
  /// Returns a list of file paths (relative to the prefix).
  /// Returns an empty list on 404 (no files).
  Future<List<String>> listFiles(String prefix) async {
    final uri = _url('$prefix?list');
    final headers = <String, String>{
      'X-Api-Key': apiKey,
    };

    final response = await http.get(uri, headers: headers);

    if (response.statusCode == 404) {
      return [];
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      try {
        final decoded = json.decode(response.body);
        if (decoded is List) {
          return decoded.cast<String>();
        }
        return [];
      } catch (_) {
        return [];
      }
    }

    throw HttpTransportException(
      'HTTP ${response.statusCode} on listFiles($prefix)',
      response.statusCode,
    );
  }

  /// Health check — verifies the Worker is reachable.
  ///
  /// Throws [HttpTransportException] on connection failure or non-2xx status.
  Future<void> healthCheck() async {
    final uri = Uri.parse('$baseUrl/health');
    final headers = <String, String>{
      'X-Api-Key': apiKey,
    };

    final response = await http.get(uri, headers: headers).timeout(
      const Duration(seconds: 5),
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode != 404) {
        throw HttpTransportException(
          'Health check failed: HTTP ${response.statusCode}',
          response.statusCode,
        );
      }
      // 404 is acceptable — not all Workers implement /health
    }
  }

  /// Delete a remote path. Idempotent — succeeds on 2xx or 404.
  Future<void> delete(String path) async {
    final uri = _url(path);
    final headers = <String, String>{
      'X-Api-Key': apiKey,
    };

    final response = await http.delete(uri, headers: headers);

    if (response.statusCode == 404 ||
        (response.statusCode >= 200 && response.statusCode < 300)) {
      _etags.remove(path);
      _lastETags.remove(path);
      return;
    }

    throw HttpTransportException(
      'HTTP ${response.statusCode} on delete($path)',
      response.statusCode,
    );
  }
}

/// Exception thrown on HTTP errors from the transport.
class HttpTransportException implements Exception {
  final String message;
  final int statusCode;

  const HttpTransportException(this.message, this.statusCode);

  @override
  String toString() => 'HttpTransportException: $message';
}
