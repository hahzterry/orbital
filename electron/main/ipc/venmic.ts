import { ipcMain } from "electron"
import log from "electron-log"
import { hasVenmic, hasPipeWire, listAudioSources, listApps, startAudioCapture, stopAudioCapture } from "../venmic"
import { getVenmicSources, setVenmicSources } from "../features/config"

export function registerVenmicIpc() {
  ipcMain.handle("venmic:has-venmic", () => {
    log.info("[IPC] venmic:has-venmic called")
    const result = hasVenmic()
    log.info("[IPC] venmic:has-venmic result:", result)
    return result
  })
  ipcMain.handle("venmic:has-pipewire", () => {
    log.info("[IPC] venmic:has-pipewire called")
    const result = hasPipeWire()
    log.info("[IPC] venmic:has-pipewire result:", result)
    return result
  })
  ipcMain.handle("venmic:list-sources", () => {
    log.info("[IPC] venmic:list-sources called")
    return listAudioSources()
  })
  ipcMain.handle("venmic:list-apps", () => {
    log.info("[IPC] venmic:list-apps called")
    return listApps()
  })
  ipcMain.handle("venmic:get-saved-sources", () => {
    log.info("[IPC] venmic:get-saved-sources called")
    return getVenmicSources()
  })
  ipcMain.handle("venmic:save-sources", (_, sources) => {
    log.info("[IPC] venmic:save-sources called with:", JSON.stringify(sources))
    setVenmicSources(sources ?? [])
  })
  ipcMain.handle("venmic:start", (_, include) => {
    log.info("[IPC] venmic:start called with:", JSON.stringify(include))
    return startAudioCapture(include)
  })
  ipcMain.handle("venmic:stop", () => {
    log.info("[IPC] venmic:stop called")
    return stopAudioCapture()
  })
}