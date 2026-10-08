import picomatch from "picomatch";

/** Built-in categories. They always apply; the config `ignore` and `secret_paths` lists add to them. */

export const SECRET_PATH_PATTERNS: readonly string[] = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.ppk",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.htpasswd",
  "**/.dockercfg",
  "**/.docker/config.json",
  "**/.aws/credentials",
  "**/credentials",
  "**/credentials.json",
  "**/service-account*.json",
  "**/secrets.{json,yml,yaml,toml}",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfstate.backup",
];

export const LOCKFILE_PATTERNS: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/go.sum",
  "**/*.lock",
];

export const VENDORED_PATTERNS: readonly string[] = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/third_party/**",
  "**/bower_components/**",
  "**/.yarn/**",
  "**/.pnpm-store/**",
];

export const BUILD_OUTPUT_PATTERNS: readonly string[] = [
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/storybook-static/**",
  "**/target/**",
];

export const GENERATED_PATH_PATTERNS: readonly string[] = [
  "**/*.min.js",
  "**/*.min.css",
  "**/*.min.mjs",
  "**/*.bundle.js",
  "**/*.map",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.gen.ts",
  "**/*.g.ts",
  "**/*.pb.go",
  "**/*_pb.js",
  "**/*_pb.d.ts",
  "**/*.pb.ts",
];

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "tif",
  "tiff",
  "svg",
  "psd",
  "sketch",
  "fig",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "tar",
  "7z",
  "rar",
  "jar",
  "war",
  "class",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "wav",
  "ogg",
  "flac",
  "pyc",
  "sqlite",
  "sqlite3",
  "db",
  "dmg",
  "iso",
]);

/**
 * Turns a user pattern into a path glob relative to the repository root, gitignore style:
 * a trailing `/` means the whole directory, a pattern with no `/` matches at any depth,
 * a leading `/` anchors it at the root. Leading `./` is dropped.
 */
export function normalizePattern(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = `${p}**`;
  if (p.startsWith("/")) return p.slice(1);
  if (!p.includes("/")) return `**/${p}`;
  return p;
}

export type PathMatcher = (path: string) => boolean;

/** Compiles globs (picomatch syntax, dotfiles included) into one predicate. Empty list never matches. */
export function compilePatterns(patterns: readonly string[]): PathMatcher {
  const globs = patterns.map(normalizePattern).filter((p) => p !== "");
  if (globs.length === 0) return () => false;
  const matcher = picomatch(globs, { dot: true });
  return (path) => matcher(path.replace(/\\/g, "/"));
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
