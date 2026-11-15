import {
  Activity, AlertTriangle, BarChart3, Bell, Bot, Box, Brain, Bug, Building2, Camera, Check, Circle,
  ClipboardList, Clapperboard, Code2, Cpu, Database, Dices, Download, Drone, Eye, FlaskConical, Folder,
  FolderOpen, GitBranch, Globe, Hash, Hexagon, Link2, Map, MapPin, Microscope, Monitor, Package, Palette,
  Play, Plug, Radio, Ruler, Save, Search, Settings, Siren, Signal, Square, Target, Timer, TrendingDown,
  TrendingUp, Upload, Waves, Wind, Wrench, X, Zap, AudioWaveform,
  type LucideIcon, type LucideProps,
} from 'lucide-react';

/**
 * Semantic icon registry.
 *
 * The platform historically stored emojis as icons (profiles, node templates,
 * widgets…). To keep a clean, professional look we never render raw emojis:
 * every icon goes through <Glyph />, which accepts either a semantic key
 * (preferred, e.g. "waves") or a legacy emoji (for persisted data) and renders
 * the matching lucide icon.
 */
export const GLYPHS = {
  waves: Waves,
  wind: Wind,
  building: Building2,
  bot: Bot,
  drone: Drone,
  radio: Radio,
  chart: BarChart3,
  zap: Zap,
  wrench: Wrench,
  search: Search,
  palette: Palette,
  settings: Settings,
  upload: Upload,
  download: Download,
  clipboard: ClipboardList,
  trendingUp: TrendingUp,
  trendingDown: TrendingDown,
  check: Check,
  close: X,
  play: Play,
  stop: Square,
  timer: Timer,
  circle: Circle,
  siren: Siren,
  alert: AlertTriangle,
  map: Map,
  monitor: Monitor,
  plug: Plug,
  branch: GitBranch,
  signal: Signal,
  package: Package,
  save: Save,
  bug: Bug,
  flask: FlaskConical,
  brain: Brain,
  microscope: Microscope,
  hash: Hash,
  link: Link2,
  bell: Bell,
  camera: Camera,
  ruler: Ruler,
  pin: MapPin,
  folder: Folder,
  folderOpen: FolderOpen,
  eye: Eye,
  code: Code2,
  dice: Dices,
  target: Target,
  clapperboard: Clapperboard,
  globe: Globe,
  hexagon: Hexagon,
  wave: AudioWaveform,
  activity: Activity,
  cpu: Cpu,
  database: Database,
  box: Box,
} satisfies Record<string, LucideIcon>;

export type GlyphName = keyof typeof GLYPHS;

/** Legacy emoji code-point -> semantic key. Variation selectors are stripped before lookup. */
const EMOJI_MAP: Record<string, GlyphName> = {
  '\u{1F30A}': 'waves', '\u{1F32C}': 'wind', '\u{1F4A8}': 'wind', '\u{1F3D7}': 'building', '\u{1F916}': 'bot', '\u{1F6F8}': 'drone',
  '\u{1F4E1}': 'radio', '\u{1F4CA}': 'chart', '\u{26A1}': 'zap', '\u{1F527}': 'wrench', '\u{1F50D}': 'search', '\u{1F3A8}': 'palette',
  '\u{2699}': 'settings', '\u{1F4E4}': 'upload', '\u{1F4E5}': 'download', '\u{1F4CB}': 'clipboard', '\u{1F4C8}': 'trendingUp',
  '\u{1F4C9}': 'trendingDown', '\u{2713}': 'check', '\u{2705}': 'check', '\u{2715}': 'close', '\u{274C}': 'close', '\u{25B6}': 'play',
  '\u{23F9}': 'stop', '\u{23F1}': 'timer', '\u{1F7E2}': 'circle', '\u{26AA}': 'circle', '\u{25CF}': 'circle', '\u{25CB}': 'circle',
  '\u{1F6A8}': 'siren', '\u{26A0}': 'alert', '\u{1F5FA}': 'map', '\u{1F5A5}': 'monitor', '\u{1F50C}': 'plug', '\u{1F500}': 'branch',
  '\u{1F4F6}': 'signal', '\u{1F4E6}': 'package', '\u{1F4BE}': 'save', '\u{1F41B}': 'bug', '\u{1F9EA}': 'flask', '\u{1F9E0}': 'brain',
  '\u{1F52C}': 'microscope', '\u{1F522}': 'hash', '\u{1F517}': 'link', '\u{1F514}': 'bell', '\u{1F4F7}': 'camera', '\u{1F4D0}': 'ruler',
  '\u{1F4CD}': 'pin', '\u{1F4C2}': 'folderOpen', '\u{1F4C1}': 'folder', '\u{1F441}': 'eye', '\u{1F40D}': 'code', '\u{1F3B2}': 'dice',
  '\u{1F3AF}': 'target', '\u{1F3AC}': 'clapperboard', '\u{1F310}': 'globe', '\u{2B21}': 'hexagon', '\u{3030}': 'wave',
};

const stripVariation = (s: string) => s.replace(/[\uFE0E\uFE0F\u200D]/g, '').trim();

export function resolveGlyph(icon?: string | null): LucideIcon {
  if (!icon) return Box;
  if (icon in GLYPHS) return GLYPHS[icon as GlyphName];
  const key = EMOJI_MAP[stripVariation(icon)];
  return key ? GLYPHS[key] : Box;
}

/** Icon keys offered in pickers (e.g. when creating a digital twin). */
export const TWIN_GLYPH_OPTIONS: GlyphName[] = [
  'waves', 'wind', 'building', 'bot', 'drone', 'zap', 'radio', 'globe', 'cpu', 'activity', 'box', 'hexagon',
];

interface GlyphProps extends Omit<LucideProps, 'ref' | 'name'> {
  /** Semantic key ("waves") or legacy stored key. */
  name?: string | null;
}

export function Glyph({ name, size = 16, strokeWidth = 1.75, ...rest }: GlyphProps) {
  const Icon = resolveGlyph(name);
  return <Icon size={size} strokeWidth={strokeWidth} {...rest} />;
}
