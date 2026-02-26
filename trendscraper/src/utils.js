import fs from "node:fs";

/**
 * Synchronously removes a folder and its contents.
 * @param {string} folder - The path to the folder to be removed.
 */
export function cleanup(folder) {
  fs.rmSync(folder, { recursive: true, force: true });
}
