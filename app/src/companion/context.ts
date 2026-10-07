// Turns "which window is in front" into what the user is doing, so the companion
// can behave like someone sitting next to you rather than a timer.
// Pure rules, no AI: fast, private, and easy to extend.

export interface Activity {
  app: string; // executable stem, lower-case: "chrome", "code", "vlc"
  name: string; // OS app name: "Google Chrome"
  title: string; // window title
  fullscreen: boolean;
}

export type Context =
  | "watching" // a video is playing in front of you → sit down and watch together
  | "meeting" // video call → leave the screen
  | "game" // fullscreen non-video app → leave the screen
  | "focus" // editor, terminal, docs → stay faint and still
  | "other";

const VIDEO_SITES = /( - YouTube\b|Netflix|Prime Video|Disney\+|Hotstar|JioCinema|Twitch|Vimeo|Crunchyroll|Hulu|Max\b)/i;
const VIDEO_APPS = /^(vlc|mpv|potplayer(mini)?(64)?|mpc-hc(64)?|mpc-be(64)?|iina|quicktime player|tv|video\.ui|microsoft\.media\.player|totem|celluloid|smplayer|kodi|stremio)$/i;
const MEETING_APPS = /^(zoom|zoom\.us|teams|ms-teams|webex|ciscowebexstart|skype)$/i;
const MEETING_TITLES = /(Zoom Meeting|Google Meet|^Meet - |Microsoft Teams.*(Meeting|Call)|Webex)/i;
const FOCUS_APPS =
  /^(code|code - insiders|cursor|windsurf|zed|idea(64)?|pycharm(64)?|webstorm(64)?|clion(64)?|goland(64)?|rider(64)?|studio(64)?|android studio|sublime_text|sublime text|notepad\+\+|devenv|xcode|nvim|vim|emacs|windowsterminal|wt|cmd|powershell|pwsh|alacritty|wezterm-gui|wezterm|kitty|iterm2|terminal|gnome-terminal-server|konsole|obsidian|notion|winword|excel|powerpnt|figma|blender)$/i;
const BROWSERS = /^(chrome|google chrome|msedge|microsoft edge|firefox|brave|brave browser|opera|vivaldi|arc|safari|chromium)$/i;

/** Windows / macOS / Linux system UI that can cover the whole screen without being a game. */
const SYSTEM_OVERLAYS =
  /^(snippingtool|screenclippinghost|screensketch|explorer|applicationframehost|lockapp|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|textinputhost|screencapture|screenshot|gnome-screenshot|spectacle|flameshot|loginwindow|dock)$/i;

export function classify(a: Activity | null): Context {
  if (!a) return "other";
  const app = a.app || a.name.toLowerCase();
  const isBrowser = BROWSERS.test(app) || BROWSERS.test(a.name);
  if (MEETING_APPS.test(app) || MEETING_TITLES.test(a.title)) return "meeting";
  if (VIDEO_APPS.test(app) || (isBrowser && VIDEO_SITES.test(a.title))) return "watching";
  if (a.fullscreen && !isBrowser && !SYSTEM_OVERLAYS.test(app)) return "game";
  if (FOCUS_APPS.test(app) || FOCUS_APPS.test(a.name)) return "focus";
  return "other";
}
