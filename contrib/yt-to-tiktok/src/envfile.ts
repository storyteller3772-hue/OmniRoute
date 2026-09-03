import { chmodSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";

/**
 * Minimal .env editor: sets keys in place, preserving comments, ordering and
 * every value it was not asked to change.
 *
 * Hand-editing a dotenv file to add credentials is where people paste onto the
 * wrong line or drop a value; this makes it one command that cannot.
 */

export function setEnvValues(content: string, updates: Record<string, string>): string {
  const lines = content.split("\n");
  const remaining = new Map(Object.entries(updates));

  const out = lines.map((line) => {
    // Leave comments and blank lines exactly as they are.
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(line);
    if (!m) return line;
    const key = m[2] as string;
    if (!remaining.has(key)) return line;
    const value = remaining.get(key) as string;
    remaining.delete(key);
    return `${m[1]}${key}=${value}`;
  });

  // Anything the file did not already mention is appended.
  if (remaining.size) {
    if (out.length && out.at(-1)?.trim() !== "") out.push("");
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
  }

  return out.join("\n");
}

export async function updateEnvFile(path: string, updates: Record<string, string>): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
    await copyFile(path, `${path}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await writeFile(path, setEnvValues(existing, updates), "utf8");
  // The file now holds a client secret.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* filesystem without POSIX modes */
  }
}

const ENTER = ["\n", "\r"];
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = ["\u0008", "\u007f"];

/**
 * Reads a value without echoing it, so a pasted secret does not sit visible on
 * screen and never reaches shell history the way a command argument would.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("not a terminal; run this interactively"));
      return;
    }
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let value = "";

    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (ENTER.includes(c)) return finish(() => resolve(value.trim()));
        if (c === CTRL_C || c === CTRL_D) return finish(() => reject(new Error("cancelled")));
        if (BACKSPACE.includes(c)) value = value.slice(0, -1);
        else value += c;
      }
    };

    const finish = (fn: () => void): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      fn();
    };

    input.on("data", onData);
  });
}
