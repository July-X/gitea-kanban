// ESM resolver hook: 'electron' → _electron-shim.mjs
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHIM_URL = pathToFileURL(path.join(__dirname, '_electron-shim.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: SHIM_URL, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
