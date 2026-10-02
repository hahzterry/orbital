// @ts-nocheck
import { join, dirname, basename } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import log from "electron-log"
import { setVenmicSources, type VenmicSource } from "./features/config"
import type { LinkData, Node, PatchBay as PatchBayType } from "@vencord/venmic";

const getModuleUrl = (): string => {
  if (typeof import.meta !== "undefined" && import.meta.url && import.meta.url !== "undefined") {
    return import.meta.url
  }
  return `file://${join(app.getAppPath(), "dist-electron/main/index.js")}`
}

const moduleUrl = getModuleUrl()
const __dirname = dirname(fileURLToPath(moduleUrl))

const APP_ROOT = app.isPackaged ? app.getAppPath() : join(__dirname, "..", "..")
let DIST_DIR: string;

if (app.isPackaged) {
  const unpackedPath = join(app.getAppPath(), "..", "app.asar.unpacked", "dist");
  DIST_DIR = unpackedPath;
} else {
  DIST_DIR = join(APP_ROOT, "dist");
}

let PatchBay: typeof PatchBayType | undefined;
let patchBayInstance: PatchBayType | undefined;
let imported = false;

export function importVenmic(): boolean {
  if (imported) return !!PatchBay;
  imported = true;

  if (process.platform !== "linux") {
    log.info("[Venmic] Skipping venmic import - not Linux")
    return false
  }

  const importPath = join(DIST_DIR, `venmic-${process.arch}.node`);
  log.info(`[Venmic] Attempting to import from: ${importPath}`);

  try {
    const venmic = require(importPath);
    log.info("[Venmic] venmic module:", venmic);
    PatchBay = venmic.PatchBay;
    log.info("[Venmic] PatchBay constructor:", PatchBay);
    return true;
  } catch (e) {
    log.error("[Venmic] Failed to import:", e);
    log.error("[Venmic] Error stack:", (e as Error).stack);
    return false;
  }
}

export function hasVenmic(): boolean {
  return importVenmic();
}

export function hasPipeWire(): boolean {
  importVenmic();
  return PatchBay?.hasPipeWire() ?? false;
}

export function listAudioSources(props?: string[]): Node[] {
  if (!patchBayInstance) {
    if (!importVenmic()) return [];
    try {
      patchBayInstance = new PatchBay();
      log.info("[Venmic] PatchBay instance created");
    } catch (e) {
      log.error("[Venmic] Failed to instantiate PatchBay:", e);
      log.error("[Venmic] Error stack:", (e as Error).stack);
      return [];
    }
  }
  const result = patchBayInstance.list(props) ?? [];
  log.info("[Venmic] Listed", result.length, "sources");
  return result;
}

export interface VenmicApp {
  pid?: string
  name: string
  hasAudio: boolean
}

const WATCHDOG_INTERVAL_MS = 3000

const GENERIC_COMMS = new Set(["wine", "wine64", "wine64-preloader", "wineserver", "python", "python3"])

let captureCriteria: VenmicSource[] = []
let seenSerials = new Set<string>()
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let isCapturing = false

// venmic matches a node when ALL props of ANY include target match the node.
// Full node snapshots carry volatile props (object.serial, node.name, ...), so
// new nodes created by the same app (games toggling outputs) would never match.
// Use stable identifiers instead: pid+name, plus name and pid fallbacks.
function buildIncludeCriteria(sources: VenmicSource[]): Node[] {
  const targets: Node[] = []
  const seen = new Set<string>()
  const push = (target: Node) => {
    const key = JSON.stringify(target)
    if (!seen.has(key)) {
      seen.add(key)
      targets.push(target)
    }
  }
  for (const source of sources) {
    const pid = source["application.process.id"]
    const name = source["application.name"]
    if (pid && name) push({ "application.process.id": pid, "application.name": name })
    if (name) push({ "application.name": name })
    if (pid) push({ "application.process.id": pid })
  }
  return targets
}

function matchesCriteria(node: Node, criteria: VenmicSource[]): boolean {
  return criteria.some((target) =>
    Object.entries(target).every(([key, value]) => node[key] === value),
  )
}

function linkDataFor(criteria: VenmicSource[]): LinkData {
  return {
    include: buildIncludeCriteria(criteria),
    exclude: [{ "media.class": "Stream/Input/Audio" }],
    ignore_devices: true,
    only_speakers: true,
    only_default_speakers: false,
  }
}

function refreshSeenSerials(): void {
  if (!patchBayInstance) return
  const all = patchBayInstance.list() ?? []
  seenSerials = new Set(
    all.filter((n) => matchesCriteria(n, captureCriteria)).map((n) => n["object.serial"]),
  )
  log.info("[Venmic] Watchdog tracking", seenSerials.size, "matching node(s)")
}

// venmic's registry worker auto-links new matching nodes, but a periodic check
// catches anything the event-driven path missed. Re-link only when a genuinely
// new node appeared: link() tears down and rebuilds every loopback.
function startWatchdog(): void {
  stopWatchdog()
  watchdogTimer = setInterval(() => {
    if (!isCapturing || !patchBayInstance || captureCriteria.length === 0) return
    try {
      const all = patchBayInstance.list() ?? []
      let discovered = false
      for (const node of all) {
        if (!matchesCriteria(node, captureCriteria)) continue
        const serial = node["object.serial"]
        if (!serial || seenSerials.has(serial)) continue
        seenSerials.add(serial)
        discovered = true
      }
      if (discovered) {
        log.info("[Venmic] New matching node(s) appeared, re-linking")
        patchBayInstance.link(linkDataFor(captureCriteria))
        refreshSeenSerials()
      }
    } catch (e) {
      log.warn("[Venmic] Watchdog check failed:", e)
    }
  }, WATCHDOG_INTERVAL_MS)
}

function stopWatchdog(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

function readProc(pid: string, file: string): string {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf-8")
  } catch {
    return ""
  }
}

// /proc/<pid>/stat: "pid (comm) state ppid ..." - comm may contain spaces/parens
function isUnlistableProcess(pid: string): boolean {
  const stat = readProc(pid, "stat")
  if (!stat) return true
  const parts = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
  if (parts[0] === "Z") return true
  return Number(parts[1]) === 2 // child of kthreadd => kernel thread
}

function processName(pid: string): string {
  const comm = readProc(pid, "comm").trim()
  if (!comm) return pid
  const cmdline = readProc(pid, "cmdline").split("\0").filter(Boolean)
  const binary = cmdline[0]
  if (binary) {
    const base = basename(binary).trim()
    if (base && (GENERIC_COMMS.has(comm) || base !== comm)) return base
  }
  return comm
}

function isVenmicOwned(node: Node): boolean {
  const description = node["node.description"] || ""
  const name = node["node.name"] || ""
  return description.startsWith("venmic-loopback") || name.startsWith("vencord-")
}

// Processes that will never be audio capture sources. Kernel truncates comm to
// 15 chars, so keep entries short. Applies to /proc entries only - venmic
// nodes are audio sources by definition and always shown. wine* is
// intentionally NOT blocked: it hosts audio for Proton games.
const BLOCKED_COMMS = new Set([
  // init & system services
  "systemd", "dbus-daemon", "dbus-broker", "dbus-launch",
  // audio infrastructure (services, never capture sources)
  "pipewire", "pipewire-pulse", "wireplumber", "pulseaudio", "rtkit", "alsactl",
  // desktop environments & compositors
  "kwin_wayland", "gnome-shell", "plasmashell", "sway", "hyprland", "xfwm4",
  "gdm", "gdm-session-worker", "lightdm", "sddm",
  // terminals & shells
  "bash", "zsh", "fish", "dash", "sh", "tmux", "screen", "konsole",
  "gnome-terminal", "kitty",
  // CLI / dev tools
  "git", "ssh", "ssh-agent", "gpg", "gpg-agent", "curl", "wget", "make",
  "cmake", "ninja", "gcc", "cc", "clang", "cargo", "rustc", "vim", "nvim",
  "emacs", "less", "grep", "sed", "awk",
  // editor/IDE helper daemons (never audio sources)
  "gitstatusd", "gopls", "forkserver", "ksmserver",
])

// Prefixes match kernel-truncated comms (15 chars) and versioned daemon names.
// Matching is case-insensitive.
const BLOCKED_PREFIXES = [
  "systemd-", "dbus-", "gvfs-", "xdg-",
  // KDE / GTK session infrastructure
  "kded", "kwin", "kaccess", "kactivity", "ksecret", "kwallet", "kdeconnect",
  "baloo", "at-spi", "startplasma", "org_kde", "polkit-kde", "msm_kde",
  "xembedsniproxy", "gmenudbusmenupr", "xsettingsd", "spectacle", "dconf",
  "krunner", "kglobalaccel", "pamac-tray", "fossilize",
  // dev tools / editors / runtimes / known non-audio apps
  "code", "python", "steamwebhelper", "node", "limux", "vicinae",
]

function isBlockedProcess(comm: string): boolean {
  if (!comm) return false
  if (BLOCKED_COMMS.has(comm)) return true
  const lower = comm.toLowerCase()
  return BLOCKED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function isOwnedByUser(pid: string): boolean {
  try {
    return statSync(`/proc/${pid}`).uid === process.getuid()
  } catch {
    return false
  }
}

// Apps with active audio outputs come from venmic; everything else comes from
// /proc so users can pick apps with no current output (e.g. minimized games).
// System processes are filtered out unless includeAll is set. Sorted by pid
// descending so new processes land on top.
export function listApps(includeAll = false): VenmicApp[] {
  const apps = new Map<string, VenmicApp>()

  for (const node of listAudioSources()) {
    if (isVenmicOwned(node)) continue
    const pid = node["application.process.id"]
    const name = node["application.name"] || node["node.name"] || "Unknown"
    const key = pid || name
    if (!key || apps.has(key)) continue
    apps.set(key, { pid: pid || undefined, name, hasAudio: true })
  }

  const ownPids = new Set(app.getAppMetrics().map((p) => String(p.pid)))

  let entries: string[] = []
  try {
    entries = readdirSync("/proc")
  } catch (e) {
    log.warn("[Venmic] Failed to read /proc:", e)
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    if (ownPids.has(entry) || apps.has(entry)) continue
    if (isUnlistableProcess(entry)) continue
    if (!isOwnedByUser(entry)) continue
    if (!includeAll && isBlockedProcess(readProc(entry, "comm").trim())) continue
    apps.set(entry, { pid: entry, name: processName(entry), hasAudio: false })
  }

  return Array.from(apps.values()).sort((a, b) => Number(b.pid ?? -1) - Number(a.pid ?? -1))
}

export function startAudioCapture(include: VenmicSource[]): boolean {
  if (!patchBayInstance) {
    if (!importVenmic()) {
      log.error("[Venmic] Cannot start capture - venmic import failed");
      return false;
    }
    try {
      patchBayInstance = new PatchBay();
      log.info("[Venmic] PatchBay instance created for capture");
    } catch (e) {
      log.error("[Venmic] Failed to instantiate PatchBay:", e);
      log.error("[Venmic] Error stack:", (e as Error).stack);
      return false;
    }
  }

  const criteria = (include ?? []).filter(
    (s) => s["application.process.id"] || s["application.name"],
  )
  if (criteria.length === 0) {
    log.error("[Venmic] No sources provided to capture");
    return false;
  }

  captureCriteria = criteria
  isCapturing = true

  const linkData = linkDataFor(criteria)
  log.info("[Venmic] Linking with criteria:", buildIncludeCriteria(criteria));
  const result = patchBayInstance.link(linkData);
  log.info("[Venmic] Link result:", result);

  setVenmicSources(criteria);
  refreshSeenSerials();
  startWatchdog();

  return result;
}

export function stopAudioCapture(): boolean {
  isCapturing = false
  stopWatchdog()
  seenSerials.clear()
  captureCriteria = []
  return patchBayInstance?.unlink() ?? false;
}