/**
 * system IPC —— Electron 系统级能力（dialog / clipboard 等）
 *
 * 目前只有 selectDirectory（dialog.showOpenDialog wrapper），
 * 后续可扩展 system.openExternal / system.showItemInFolder 等。
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IpcChannel } from '../../shared/ipc-channels.js';
import { logger } from '../logger.js';

/**
 * 系统目录选择器（Electron dialog.showOpenDialog wrapper）
 *
 * @returns 选中的路径字符串；取消返 null
 */
async function selectDirectoryHandler(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    logger.warn('system.selectDirectory: no focused window');
    return null;
  }
  const result = await dialog.showOpenDialog(win, {
    title: '选择工作区目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

export function registerSystemIpc(): void {
  ipcMain.handle(IpcChannel.SYSTEM_SELECT_DIRECTORY, selectDirectoryHandler);
}

export function unregisterSystemIpc(): void {
  ipcMain.removeHandler(IpcChannel.SYSTEM_SELECT_DIRECTORY);
}
