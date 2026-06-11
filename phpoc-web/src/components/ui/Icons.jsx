/**
 * Icons — centralized SVG icon component using Lucide (MIT license).
 *
 * All icons in the app are defined here, mapped to semantic names.
 * Import from this file instead of hardcoding emoji or Lucide import paths.
 *
 * If an icon you need doesn't exist in Lucide, add a simple inline SVG here.
 */

import {
  Home,
  Clock,
  Plus,
  Tags,
  User,
  RefreshCw,
  Settings,
  Lock,
  Play,
  Pause,
  Square,
  Check,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  WifiOff,
  ClipboardList,
  ChevronRight,
  LogOut,
  Hash,
  Sun,
  Moon,
  Server,
  Key,
  Activity,
  Bookmark,
  List,
  FileText,
  Smartphone,
} from 'lucide-react';

/**
 * Icons map — semantic name → Lucide component.
 * Add new icons here as the app grows.
 */
export const Icons = {
  // Bottom nav
  dashboard: Home,
  clock: Clock,
  history: Clock,
  'new-task': Plus,
  tags: Tags,
  profile: User,
  sync: RefreshCw,
  settings: Settings,
  lock: Lock,

  // Task controls
  play: Play,
  pause: Pause,
  stop: Square,

  // Sync status
  syncReady: CheckCircle2,
  syncPending: AlertTriangle,
  syncing: RefreshCw,
  offline: WifiOff,
  reauthNeeded: AlertCircle,

  // Misc
  clipboard: ClipboardList,
  chevronRight: ChevronRight,
  logout: LogOut,
  hash: Hash,
  sun: Sun,
  moon: Moon,
  server: Server,
  key: Key,
  activity: Activity,
  bookmark: Bookmark,
  list: List,
  fileText: FileText,
  smartphone: Smartphone,

  check: Check,

  // Fallback: render emoji as SVG alternative
  devMode: Smartphone,
  production: Lock,
};
