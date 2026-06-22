// _e2e-loader.mjs —— 通过 --import= 注入 ESM resolver hook
// 把 'electron' 重定向到 _electron-shim.mjs 的 stub

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

register(path.join(__dirname, '_electron-shim-resolver.mjs'), pathToFileURL(__dirname + '/'));

// 让 node 知道这个 module 有副作用
export const _loaded = true;
