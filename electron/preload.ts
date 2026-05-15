import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { ApiBridge } from '../shared/ipc';

const api: ApiBridge = {
  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  getAccount: (id) => ipcRenderer.invoke(IPC.getAccount, id),
  upsertAccount: (a) => ipcRenderer.invoke(IPC.upsertAccount, a),
  deleteAccount: (id) => ipcRenderer.invoke(IPC.deleteAccount, id),
  listEntries: (accountId) => ipcRenderer.invoke(IPC.listEntries, accountId),
  insertEntry: (e) => ipcRenderer.invoke(IPC.insertEntry, e),
  deleteEntry: (id) => ipcRenderer.invoke(IPC.deleteEntry, id),
  computeState: (id) => ipcRenderer.invoke(IPC.computeState, id),
  computeAllStates: () => ipcRenderer.invoke(IPC.computeAllStates),
  listSkills: () => ipcRenderer.invoke(IPC.listSkills),
  setSecret: (accountId, key, value) => ipcRenderer.invoke(IPC.setSecret, accountId, key, value),
  syncNow: (accountId) => ipcRenderer.invoke(IPC.syncNow, accountId),
  exportData: (format) => ipcRenderer.invoke(IPC.exportData, format),
};

contextBridge.exposeInMainWorld('api', api);
