import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ReadPolicyOptions {
  /** Extra Codex state roots, primarily for tests and embedders. Runtime env roots are included by default. */
  codexHomes?: readonly string[];
  githubCliHomes?: readonly string[];
  gcloudHomes?: readonly string[];
  azureHomes?: readonly string[];
  kubeConfigPaths?: readonly string[];
  npmrcPaths?: readonly string[];
  platform?: NodeJS.Platform;
}

/** rg exclusions for lexically named stores. Canonical aliases fall back to the policy-aware JS walk. */
const fileWithWriteVariants = (glob: string): string[] => [glob, `${glob}.*`, `${glob}-*`];
export const CREDENTIAL_READ_DENY_GLOBS = [
  "**/.ssh/**", "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*",
  "**/.gnupg/**", "**/.aws/**", "**/.docker/config.json", "**/.netrc",
  "**/.git-credentials", ...fileWithWriteVariants("**/.neko-core/config.json"), "**/.env*",
  ...fileWithWriteVariants("**/.neko-core/chatgpt-auth.json"), ...fileWithWriteVariants("**/.neko-core/kimi-auth.json"),
  "**/.neko-core/mcp-auth/**", ...fileWithWriteVariants("**/oauth_creds.json"),
  ...fileWithWriteVariants("**/.neko-core/relay.json"), "**/.neko-core/relay-sessions/**",
  ...fileWithWriteVariants("**/.neko-core/remote.json"), ...fileWithWriteVariants("**/.neko-core/browser-bridge.json"),
  ...fileWithWriteVariants("**/.neko-core/codex-home/auth.json"), ...fileWithWriteVariants("**/.codex/auth.json"),
  "**/.neko-core/browser/**", "**/.codex/secrets/**", "**/.codex/.sandbox-secrets/**",
  ...fileWithWriteVariants("**/.npmrc"), ...fileWithWriteVariants("**/.pypirc"),
  ...fileWithWriteVariants("**/.config/gh/hosts.yml"), ...fileWithWriteVariants("**/.config/gh/hosts.yaml"),
  ...fileWithWriteVariants("**/GitHub CLI/hosts.yml"), ...fileWithWriteVariants("**/GitHub CLI/hosts.yaml"),
  ...fileWithWriteVariants("**/AppData/Roaming/gh/hosts.yml"), ...fileWithWriteVariants("**/AppData/Roaming/gh/hosts.yaml"),
  ...fileWithWriteVariants("**/.config/gcloud/application_default_credentials.json"),
  ...fileWithWriteVariants("**/.config/gcloud/credentials.db"), ...fileWithWriteVariants("**/.config/gcloud/access_tokens.db"),
  "**/.config/gcloud/legacy_credentials/**",
  ...fileWithWriteVariants("**/AppData/Roaming/gcloud/application_default_credentials.json"),
  ...fileWithWriteVariants("**/AppData/Roaming/gcloud/credentials.db"), ...fileWithWriteVariants("**/AppData/Roaming/gcloud/access_tokens.db"),
  "**/AppData/Roaming/gcloud/legacy_credentials/**",
  ...fileWithWriteVariants("**/.azure/accessTokens.json"), ...fileWithWriteVariants("**/.azure/msal_token_cache.bin"),
  ...fileWithWriteVariants("**/.azure/msal_token_cache.json"), ...fileWithWriteVariants("**/.azure/service_principal_entries.json"),
  ...fileWithWriteVariants("**/.kube/config"),
  "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.keystore", "**/*.ppk",
  "**/Keychains/**", "**/Login Data", "**/Cookies", "**/Web Data", "**/User Data/**",
  "**/etc/shadow", "**/etc/sudoers", "**/etc/gshadow",
] as const;

/** Windows treats these case-insensitive leaf names (even with an extension) as devices, not files. */
export const WINDOWS_DEVICE_READ_DENY_GLOBS = [
  "**/[cC][oO][nN]", "**/[cC][oO][nN].*",
  "**/[pP][rR][nN]", "**/[pP][rR][nN].*",
  "**/[aA][uU][xX]", "**/[aA][uU][xX].*",
  "**/[nN][uU][lL]", "**/[nN][uU][lL].*",
  "**/[cC][oO][mM][1-9]", "**/[cC][oO][mM][1-9].*",
  "**/[lL][pP][tT][1-9]", "**/[lL][pP][tT][1-9].*",
] as const;

/** Credential/control-shaped paths that safe read/context surfaces must never expose to a model. */
const CREDENTIAL_PATHS: Array<[RegExp, string]> = [
  [/(^|[\\/])\.ssh([\\/]|$)/i, "SSH keys"],
  [/(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)([.\\/]|$)/i, "a private key"],
  [/(^|[\\/])\.gnupg([\\/]|$)/i, "GnuPG keys"],
  [/(^|[\\/])\.aws([\\/]|$)/i, "AWS credentials"],
  [/(^|[\\/])\.docker[\\/]config\.json$/i, "Docker credentials"],
  [/(^|[\\/])\.netrc$/i, "netrc credentials"],
  [/(^|[\\/])\.git-credentials$/i, "git credentials"],
  [/(^|[\\/])\.neko-core[\\/]config\.json(?:[.-][^\\/]*)?$/i, "Neko's own key store"],
  [/(^|[\\/])\.neko-core[\\/](chatgpt-auth|kimi-auth)\.json(?:[.-][^\\/]*)?$/i, "Neko authentication credentials"],
  [/(^|[\\/])\.neko-core[\\/]mcp-auth([\\/]|$)/i, "Neko MCP OAuth credentials"],
  [/(^|[\\/])oauth_creds\.json(?:[.-][^\\/]*)?$/i, "Gemini OAuth credentials"],
  [/(^|[\\/])\.neko-core[\\/]relay-sessions([\\/]|$)/i, "Neko relay session credentials"],
  [/(^|[\\/])\.neko-core[\\/](relay|remote|browser-bridge)\.json(?:[.-][^\\/]*)?$/i, "Neko control credentials"],
  [/(^|[\\/])\.neko-core[\\/]codex-home[\\/]auth\.json(?:[.-][^\\/]*)?$/i, "Codex credentials"],
  [/(^|[\\/])\.codex[\\/]auth\.json(?:[.-][^\\/]*)?$/i, "Codex credentials"],
  [/(^|[\\/])\.codex[\\/](secrets|\.sandbox-secrets)([\\/]|$)/i, "Codex credentials"],
  [/(^|[\\/])\.neko-core[\\/]browser([\\/]|$)/i, "a browser profile"],
  [/(^|[\\/])\.npmrc(?:[.-][^\\/]*)?$/i, "npm credentials"],
  [/(^|[\\/])\.pypirc(?:[.-][^\\/]*)?$/i, "PyPI credentials"],
  [/(^|[\\/])\.config[\\/]gh[\\/]hosts\.ya?ml(?:[.-][^\\/]*)?$/i, "GitHub CLI credentials"],
  [/(^|[\\/])GitHub CLI[\\/]hosts\.ya?ml(?:[.-][^\\/]*)?$/i, "GitHub CLI credentials"],
  [/(^|[\\/])AppData[\\/]Roaming[\\/]gh[\\/]hosts\.ya?ml(?:[.-][^\\/]*)?$/i, "GitHub CLI credentials"],
  [/(^|[\\/])(?:\.config[\\/]|AppData[\\/]Roaming[\\/])gcloud[\\/](?:application_default_credentials\.json|credentials\.db|access_tokens\.db)(?:[.-][^\\/]*)?$/i, "Google Cloud credentials"],
  [/(^|[\\/])(?:\.config[\\/]|AppData[\\/]Roaming[\\/])gcloud[\\/]legacy_credentials([\\/]|$)/i, "Google Cloud credentials"],
  [/(^|[\\/])\.azure[\\/](?:accessTokens\.json|msal_token_cache\.(?:bin|json)|service_principal_entries\.json)(?:[.-][^\\/]*)?$/i, "Azure credentials"],
  [/(^|[\\/])\.kube[\\/]config(?:[.-][^\\/]*)?$/i, "Kubernetes credentials"],
  [/(^|[\\/])\.env[^\\/]*$/i, "an environment file"],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, "key material"],
  [/(^|[\\/])(Keychains|Login Data|Cookies|Web Data)([\\/]|$)/i, "a credential store"],
  [/(^|[\\/])User Data[\\/]/i, "a browser profile"],
  [/^\/etc\/(shadow|sudoers|gshadow)/i, "a system credential file"],
  [/^[/\\](proc|sys)([/\\]|$)/i, "a virtual system filesystem"],
  [/^[/\\]dev([/\\]|$)/i, "a device file"],
];

const WINDOWS_DEVICE_LEAF = /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[.:][^\\/]*)?[ .]*$/i;
const WINDOWS_DEVICE_NAMESPACE = /^\\\\(?:\.[\\/]|\?[\\/]GLOBALROOT[\\/])/i;
const CODEX_AUTH_LEAF = /^auth\.json(?:[.-][^\\/]*)?$/i;

function configuredCodexHomes(options: ReadPolicyOptions): string[] {
  return (options.codexHomes ?? [process.env.NEKO_CODEX_HOME, process.env.CODEX_HOME])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function values(items: readonly unknown[]): string[] {
  return items.map((value) => String(value ?? "").trim()).filter(Boolean);
}

function configuredGitHubCliHomes(options: ReadPolicyOptions): string[] {
  if (options.githubCliHomes) return values(options.githubCliHomes);
  const appData = String(process.env.APPDATA ?? "").trim();
  const xdg = String(process.env.XDG_CONFIG_HOME ?? "").trim();
  return values([
    process.env.GH_CONFIG_DIR,
    xdg && join(xdg, "gh"),
    appData && join(appData, "GitHub CLI"),
    appData && join(appData, "gh"),
  ]);
}

function configuredGcloudHomes(options: ReadPolicyOptions): string[] {
  if (options.gcloudHomes) return values(options.gcloudHomes);
  const appData = String(process.env.APPDATA ?? "").trim();
  const xdg = String(process.env.XDG_CONFIG_HOME ?? "").trim();
  return values([process.env.CLOUDSDK_CONFIG, xdg && join(xdg, "gcloud"), appData && join(appData, "gcloud")]);
}

function configuredAzureHomes(options: ReadPolicyOptions): string[] {
  return options.azureHomes ? values(options.azureHomes) : values([process.env.AZURE_CONFIG_DIR]);
}

function configuredKubeFiles(options: ReadPolicyOptions): string[] {
  if (options.kubeConfigPaths) return values(options.kubeConfigPaths);
  return values(String(process.env.KUBECONFIG ?? "").split(delimiter));
}

function configuredNpmrcFiles(options: ReadPolicyOptions): string[] {
  return options.npmrcPaths ? values(options.npmrcPaths) : values([process.env.NPM_CONFIG_USERCONFIG]);
}

function relativeInside(root: string, path: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) ? null : rel;
}

function isConfiguredCodexAuth(path: string, homes: readonly string[]): boolean {
  return homes.some((home) => {
    const rel = relativeInside(home, path);
    return rel !== null && !rel.includes(sep) && CODEX_AUTH_LEAF.test(rel);
  });
}

function isConfiguredDirectChild(path: string, homes: readonly string[], file: RegExp): boolean {
  return homes.some((home) => {
    const rel = relativeInside(home, path);
    return rel !== null && !rel.includes(sep) && file.test(rel);
  });
}

function isConfiguredGcloudCredential(path: string, homes: readonly string[]): boolean {
  return homes.some((home) => {
    const rel = relativeInside(home, path);
    if (rel === null) return false;
    if (/^legacy_credentials(?:[\\/]|$)/i.test(rel)) return true;
    return !rel.includes(sep) && /^(application_default_credentials\.json|credentials\.db|access_tokens\.db)(?:[.-][^\\/]*)?$/i.test(rel);
  });
}

function isConfiguredFile(path: string, files: readonly string[]): boolean {
  const candidate = resolve(path);
  return files.some((file) => candidate === resolve(file));
}

export function deniedCredentialPath(path: string, options: ReadPolicyOptions = {}): string | null {
  for (const [pattern, what] of CREDENTIAL_PATHS) if (pattern.test(path)) return what;
  if ((options.platform ?? process.platform) === "win32"
    && (WINDOWS_DEVICE_LEAF.test(path) || WINDOWS_DEVICE_NAMESPACE.test(path))) return "a Windows device";
  if (isConfiguredCodexAuth(path, configuredCodexHomes(options))) return "Codex credentials";
  if (isConfiguredDirectChild(path, configuredGitHubCliHomes(options), /^hosts\.ya?ml(?:[.-][^\\/]*)?$/i)) return "GitHub CLI credentials";
  if (isConfiguredGcloudCredential(path, configuredGcloudHomes(options))) return "Google Cloud credentials";
  if (isConfiguredDirectChild(path, configuredAzureHomes(options), /^(accessTokens\.json|msal_token_cache\.(?:bin|json)|service_principal_entries\.json)(?:[.-][^\\/]*)?$/i)) return "Azure credentials";
  if (isConfiguredFile(path, configuredKubeFiles(options))) return "Kubernetes credentials";
  if (isConfiguredFile(path, configuredNpmrcFiles(options))) return "npm credentials";
  return null;
}

/** rg does not follow symlinks by default, but an explicitly selected alias/container needs the JS
 * walker so every descendant is checked against its canonical target before being opened. */
export function requiresPolicyAwareSearch(path: string, options: ReadPolicyOptions = {}): boolean {
  if (/(^|[\\/])(\.neko-core|\.codex)([\\/]|$)/i.test(path)) return true;
  const candidate = resolve(path);
  if ((options.platform ?? process.platform) !== "win32") {
    for (const virtual of ["/proc", "/sys", "/dev"]) {
      if (candidate === virtual || relativeInside(candidate, virtual) !== null || relativeInside(virtual, candidate) !== null) return true;
    }
  }
  const protectedRoots = [
    ...configuredCodexHomes(options),
    ...configuredGitHubCliHomes(options),
    ...configuredGcloudHomes(options),
    ...configuredAzureHomes(options),
    ...configuredKubeFiles(options),
    ...configuredNpmrcFiles(options),
  ];
  return protectedRoots.some((home) => {
    const root = resolve(home);
    return candidate === root || relativeInside(root, candidate) !== null || relativeInside(candidate, root) !== null;
  });
}
