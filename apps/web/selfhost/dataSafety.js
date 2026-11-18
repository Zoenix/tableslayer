/**
 * Guards against the most common self-hosting data loss: running without the
 * data directory mounted from the host. Without a mount, everything is written
 * into the container and silently discarded when an update recreates it.
 */
import fs from 'fs';
import path from 'path';

/** Parses /proc/self/mountinfo lines into { root, mountPoint, fsType, source }. */
export const parseMountInfo = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [left, right = ''] = line.split(' - ');
      const fields = left.split(' ');
      const [fsType, source] = right.split(' ');
      return { root: fields[3], mountPoint: fields[4], fsType, source };
    });

export const findMount = (dir, mountInfoText) =>
  parseMountInfo(mountInfoText).findLast((mount) => mount.mountPoint === dir) ?? null;

/**
 * Exits the process when `dataRoot` is not a mount (Linux only). Set
 * REQUIRE_DATA_MOUNT=false to run with throwaway data on purpose.
 */
export const assertPersistentDataRoot = (dataRoot) => {
  if (process.env.REQUIRE_DATA_MOUNT === 'false') return;
  let mountInfo;
  try {
    mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf-8');
  } catch {
    return; // Not Linux (local development): nothing to check
  }

  const mount = findMount(path.resolve(dataRoot), mountInfo);
  if (!mount) {
    console.error(
      [
        '',
        `❌ ${dataRoot} is not mounted from the host, so all data would be lost on the next update.`,
        `   Mount a host folder or dataset at ${dataRoot} on BOTH containers, e.g.:`,
        '',
        '     volumes:',
        `       - /mnt/<pool>/apps/tableslayer:${dataRoot}`,
        '',
        '   (Set REQUIRE_DATA_MOUNT=false to start anyway with throwaway data.)',
        ''
      ].join('\n')
    );
    process.exit(1);
  }
  console.log(
    `💾 Data directory ${dataRoot} → ${mount.source}${mount.root === '/' ? '' : mount.root} (${mount.fsType})`
  );
};

/**
 * Snapshots a local SQLite database into `backupDir` before migrations,
 * keeping the newest `keep` copies. Uses VACUUM INTO, which is safe while the
 * database is in use and produces a compact, standalone file.
 */
export const backupDatabase = async (client, dbFile, backupDir, keep = 10) => {
  if (!fs.existsSync(dbFile) || fs.statSync(dbFile).size === 0) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `tableslayer-${stamp}.db`);
  await client.execute({ sql: 'VACUUM INTO ?', args: [target] });

  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => /^tableslayer-.*\.db$/.test(name))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    fs.rmSync(path.join(backupDir, old));
  }
  return target;
};
