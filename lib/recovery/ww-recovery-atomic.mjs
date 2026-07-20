import process from "node:process";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function renameRecoveryFile(fsImpl, sourcePath, targetPath, {
  platform = process.platform,
  retries = 20,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsImpl.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (
        platform !== "win32"
        || !WINDOWS_RENAME_RETRY_CODES.has(error?.code)
        || attempt >= retries
      ) throw error;
      await delayImpl(Math.min(100, 5 * (attempt + 1)));
    }
  }
}
