import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'app.dart';
import 'data/commonplace/commonplace_service.dart';
import 'data/storage/database.dart';
import 'data/storage/preferences.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Pre-resolve the database file path (synchronous open after path resolution).
  final dir = await getApplicationDocumentsDirectory();
  AppDatabase.setDatabasePath(p.join(dir.path, 'phpoc.db'));
  // Pre-resolve the Commonplace `commonplace.json` path (ADR-031 separate file).
  CommonplaceService.preResolvedPath = p.join(dir.path, 'commonplace.json');

  // Pre-open SharedPreferences for synchronous provider access.
  final appPrefs = await AppPreferences.open();
  AppPreferences.setInstance(appPrefs);

  runApp(
    const ProviderScope(child: PhpocApp()),
  );
}
