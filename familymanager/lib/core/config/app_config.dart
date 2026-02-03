import 'package:flutter_dotenv/flutter_dotenv.dart';

/// App-weite Konfiguration
class AppConfig {
  // Supabase
  static String get supabaseUrl => dotenv.env['SUPABASE_URL'] ?? '';
  static String get supabaseAnonKey => dotenv.env['SUPABASE_ANON_KEY'] ?? '';

  // App Settings
  static const int minimumPasswordLength = 8;
  static const int maxPhotoSizeMB = 5;
  static const int defaultCreditsPerMinute = 1;

  // Default Credit Values
  static const int creditsEasy = 5;
  static const int creditsMedium = 10;
  static const int creditsHard = 20;
}
