/**
 * Human-readable file-type labels modelled after WinSCP's "Type" column.
 *
 * The goal is parity with what a long-time WinSCP user expects to see:
 *
 *   - Directories                       → "File folder"
 *   - Symbolic links                    → "Shortcut"
 *   - Known extensions/dotfiles         → friendly descriptive name
 *   - Unknown but with extension        → "EXT File"  (uppercase)
 *   - Unknown dotfile (no real ext)     → "BASENAME File" (uppercase, no dot)
 *   - Bare files with no extension      → "File"
 *
 * Pattern conventions, mirroring the screenshot the user provided:
 *
 *   - Source-code-ish formats end in "Source File"
 *     ("Bash RC Source File", "SQL Source File", "Text Source File", …)
 *   - Pure data formats end in "File"
 *     ("JSON File", "YAML File", "BACKUP File", …)
 *
 * The lookup is intentionally a flat object literal — not a Map — so adding
 * a new mapping is a single-line change and the table can be inlined into
 * the bundle without runtime construction cost. Order doesn't matter; ext
 * keys are stored lowercased and basename keys are stored as the literal
 * filename (without any leading dot).
 */

import type { LocalListEntry, RemoteListEntry } from "@shared/types";

type AnyEntry = LocalListEntry | RemoteListEntry;

/* --- Basename lookup (used for dotfiles like .bashrc, .gitconfig, …) --- */
const BASENAME_LABELS: Record<string, string> = {
  bashrc: "Bash RC Source File",
  bash_profile: "Bash Profile Source File",
  bash_logout: "Bash Logout Source File",
  bash_history: "BASH_HISTORY File",
  zshrc: "Zsh RC Source File",
  zprofile: "Zsh Profile Source File",
  zshenv: "Zsh Env Source File",
  zsh_history: "ZSH_HISTORY File",
  profile: "Profile Source File",
  inputrc: "Inputrc Source File",
  vimrc: "Vim RC Source File",
  viminfo: "VIMINFO File",
  emacs: "Emacs Source File",
  gitconfig: "Git Config Source File",
  gitignore: "Git Ignore Source File",
  gitattributes: "Git Attributes Source File",
  gitmodules: "Git Modules Source File",
  gitkeep: "Git Keep File",
  npmrc: "NPM RC Source File",
  yarnrc: "Yarn RC Source File",
  nvmrc: "NVM RC Source File",
  editorconfig: "EditorConfig Source File",
  prettierrc: "Prettier RC Source File",
  eslintrc: "ESLint RC Source File",
  babelrc: "Babel RC Source File",
  dockerignore: "Docker Ignore Source File",
  env: "Environment Source File",
  htaccess: "Apache Config Source File",
  minttyrc: "MINTTYRC File",
  node_repl_history: "NODE_REPL_HISTORY File",
  python_history: "PYTHON_HISTORY File",
  mysql_history: "MYSQL_HISTORY File",
  psql_history: "PSQL_HISTORY File",
  rediscli_history: "REDIS_HISTORY File",
  ssh: "SSH Folder",
};

/* --- Extension lookup ------------------------------------------------- */
const EXT_LABELS: Record<string, string> = {
  // Plain text / docs
  txt: "Text Source File",
  md: "Markdown Source File",
  markdown: "Markdown Source File",
  rst: "reStructuredText Source File",
  log: "Log File",
  rtf: "Rich Text Document",
  pdf: "PDF Document",
  doc: "Word Document",
  docx: "Word Document",
  xls: "Excel Spreadsheet",
  xlsx: "Excel Spreadsheet",
  ppt: "PowerPoint Presentation",
  pptx: "PowerPoint Presentation",

  // Data / config
  json: "JSON File",
  jsonc: "JSON with Comments File",
  json5: "JSON5 File",
  yaml: "YAML File",
  yml: "YAML File",
  xml: "XML File",
  toml: "TOML File",
  ini: "Configuration Source File",
  conf: "Configuration Source File",
  cfg: "Configuration Source File",
  properties: "Properties Source File",
  csv: "CSV File",
  tsv: "TSV File",
  env: "Environment Source File",

  // Shells / scripts
  sh: "Shell Source File",
  bash: "Bash Source File",
  zsh: "Zsh Source File",
  fish: "Fish Source File",
  ps1: "PowerShell Source File",
  psm1: "PowerShell Module Source File",
  bat: "Batch File",
  cmd: "Batch File",

  // Web / app source
  html: "HTML Source File",
  htm: "HTML Source File",
  xhtml: "XHTML Source File",
  css: "Stylesheet Source File",
  scss: "SCSS Source File",
  sass: "Sass Source File",
  less: "Less Source File",
  styl: "Stylus Source File",
  js: "JavaScript Source File",
  mjs: "JavaScript Module Source File",
  cjs: "JavaScript Source File",
  ts: "TypeScript Source File",
  tsx: "TypeScript JSX Source File",
  jsx: "JavaScript JSX Source File",
  vue: "Vue Source File",
  svelte: "Svelte Source File",
  astro: "Astro Source File",

  // Other languages
  py: "Python Source File",
  pyi: "Python Stub Source File",
  rb: "Ruby Source File",
  rs: "Rust Source File",
  go: "Go Source File",
  java: "Java Source File",
  kt: "Kotlin Source File",
  scala: "Scala Source File",
  swift: "Swift Source File",
  c: "C Source File",
  h: "C Header File",
  cpp: "C++ Source File",
  cc: "C++ Source File",
  cxx: "C++ Source File",
  hpp: "C++ Header File",
  cs: "C# Source File",
  fs: "F# Source File",
  php: "PHP Source File",
  pl: "Perl Source File",
  lua: "Lua Source File",
  r: "R Source File",
  dart: "Dart Source File",
  ex: "Elixir Source File",
  exs: "Elixir Script Source File",
  erl: "Erlang Source File",
  clj: "Clojure Source File",
  lisp: "Lisp Source File",
  hs: "Haskell Source File",
  ml: "OCaml Source File",
  zig: "Zig Source File",

  // SQL / databases
  sql: "SQL Source File",
  db: "Database File",
  sqlite: "SQLite Database File",
  sqlite3: "SQLite Database File",
  mdb: "Access Database File",

  // Archives / packages
  zip: "ZIP Archive",
  tar: "TAR Archive",
  gz: "GZip Archive",
  tgz: "TGZ Archive",
  bz2: "BZip2 Archive",
  tbz: "TBZ Archive",
  tbz2: "TBZ2 Archive",
  xz: "XZ Archive",
  txz: "TXZ Archive",
  zst: "Zstandard Archive",
  "7z": "7-Zip Archive",
  rar: "RAR Archive",
  jar: "Java Archive",
  war: "Web Archive",
  apk: "Android Package",
  ipa: "iOS Application",
  deb: "Debian Package",
  rpm: "RPM Package",
  dmg: "Disk Image",
  iso: "Disc Image",

  // Images
  png: "PNG Image",
  jpg: "JPEG Image",
  jpeg: "JPEG Image",
  gif: "GIF Image",
  bmp: "Bitmap Image",
  webp: "WebP Image",
  svg: "SVG Image",
  ico: "Icon File",
  tif: "TIFF Image",
  tiff: "TIFF Image",
  heic: "HEIC Image",
  avif: "AVIF Image",
  psd: "Photoshop Document",

  // Audio / video
  mp3: "MP3 Audio",
  wav: "WAV Audio",
  ogg: "OGG Audio",
  oga: "OGG Audio",
  flac: "FLAC Audio",
  m4a: "M4A Audio",
  aac: "AAC Audio",
  wma: "WMA Audio",
  mp4: "MP4 Video",
  m4v: "M4V Video",
  mov: "QuickTime Video",
  avi: "AVI Video",
  mkv: "Matroska Video",
  webm: "WebM Video",
  wmv: "WMV Video",
  flv: "Flash Video",

  // Crypto / certificates
  pem: "Certificate File",
  crt: "Certificate File",
  cer: "Certificate File",
  der: "Certificate File",
  key: "Key File",
  pub: "Public Key File",
  pfx: "PFX Certificate File",
  p12: "PKCS#12 Certificate File",

  // Executables / binaries
  exe: "Application",
  msi: "Installer Package",
  app: "Application",
  dll: "Application Extension",
  so: "Shared Object",
  dylib: "Dynamic Library",
  bin: "Binary File",
  o: "Object File",
  obj: "Object File",

  // Misc / dev
  patch: "Patch File",
  diff: "Diff File",
  bak: "Backup File",
  backup: "BACKUP File",
  old: "Old File",
  tmp: "Temporary File",
  swp: "Vim Swap File",
  lock: "Lock File",
  pid: "PID File",
  pem8: "PEM Key File",
};

/** Extract the extension (without the dot, lowercased) from a filename, or
 *  null when there isn't one. Leading-dot files like ".bashrc" are NOT
 *  considered to have an extension — those go through the basename map. */
function extOf(name: string): string | null {
  if (name.startsWith(".")) return null;
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return null;
  return name.slice(i + 1).toLowerCase();
}

/** WinSCP-style human-readable type label for an entry. */
export function typeLabelForEntry(entry: AnyEntry): string {
  if (entry.type === "dir") return "File folder";
  if (entry.type === "link") return "Shortcut";
  if (entry.type === "other") return "Special File";

  const name = entry.name;

  // Dotfiles: the basename (sans dot) is the meaningful key.
  if (name.startsWith(".")) {
    const base = name.slice(1).toLowerCase();
    const known = BASENAME_LABELS[base];
    if (known) return known;
    // Fallback: for unknown dotfiles, mirror WinSCP's "BASH_HISTORY File"
    // shape — uppercase basename + " File".
    return `${base.toUpperCase()} File`;
  }

  const ext = extOf(name);
  if (ext) {
    const known = EXT_LABELS[ext];
    if (known) return known;
    return `${ext.toUpperCase()} File`;
  }

  // Some unix tools and configs are recognized by basename even without a
  // leading dot (Makefile, Dockerfile, …). These are case-insensitive.
  const baseLower = name.toLowerCase();
  switch (baseLower) {
    case "makefile":
      return "Makefile Source File";
    case "dockerfile":
      return "Dockerfile Source File";
    case "vagrantfile":
      return "Vagrantfile Source File";
    case "rakefile":
      return "Rakefile Source File";
    case "gemfile":
      return "Gemfile Source File";
    case "podfile":
      return "Podfile Source File";
    case "license":
    case "licence":
      return "License File";
    case "readme":
      return "Readme File";
    case "changelog":
      return "Changelog File";
    case "todo":
      return "TODO File";
    case "authors":
    case "contributors":
      return "Text File";
  }

  return "File";
}
