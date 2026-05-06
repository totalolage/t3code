import { contextBridge, ipcRenderer } from "electron";

import { exposeEffectElectronRpcPreloadBridge } from "effect-electron-rpc/preload";

exposeEffectElectronRpcPreloadBridge({
  contextBridge,
  ipcRenderer,
});
