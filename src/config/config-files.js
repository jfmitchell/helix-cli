/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readTree(root, directory = 'site-config') {
  const dir = path.join(root, directory);
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return {
      version: 'missing', files: new Map(), directories: new Set(), mode: 0o755,
    };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('site-config must be a real directory, not a symlink');
  }
  const files = new Map();
  const directories = new Set();
  const directoryModes = new Map();
  const hash = createHash('sha256');
  const walk = async (current, relative = '') => {
    const before = await fs.lstat(current);
    hash.update(JSON.stringify([relative, before.ino, before.mode, before.mtimeMs]));
    if (before.isSymbolicLink()) {
      throw new Error(`${relative}: symlinks are not supported`);
    }
    if (before.isDirectory()) {
      directories.add(relative);
      directoryModes.set(relative, before.mode % 0o1000);
      const entries = (await fs.readdir(current)).sort();
      for (const name of entries) {
        // eslint-disable-next-line no-await-in-loop
        await walk(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
    } else if (before.isFile()) {
      const content = await fs.readFile(current);
      files.set(relative, { content, mode: before.mode % 0o1000 });
      hash.update(content);
    } else {
      throw new Error(`${relative}: expected a regular file or directory`);
    }
    const after = await fs.lstat(current);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode
      || before.size !== after.size) {
      throw new Error('Configuration changed while it was being read; retry the command');
    }
  };
  await walk(dir);
  const latest = await fs.lstat(dir);
  if (stat.ino !== latest.ino || stat.mode !== latest.mode || stat.mtimeMs !== latest.mtimeMs) {
    throw new Error('Configuration changed while it was being read; retry the command');
  }
  return {
    version: hash.digest('hex'), files, directories, directoryModes, mode: stat.mode % 0o1000,
  };
}

export function fileChanges(before, after) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((name) => {
    if (!before.has(name)) {
      return [`add ${name}`];
    }
    if (!after.has(name)) {
      return [`remove ${name}`];
    }
    return Buffer.from(before.get(name).content).equals(Buffer.from(after.get(name).content))
      ? [] : [`update ${name}`];
  });
}

/**
 * Stage and swap a complete tree under a writer lock. Keep the original tree
 * intact until staging and the optimistic concurrency check both succeed.
 */
export async function installTree(root, previous, files, directories = previous.directories) {
  const target = path.join(root, 'site-config');
  const lockPath = path.join(root, '.site-config.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Another config writer holds .site-config.lock; retry after it finishes');
    }
    throw error;
  }
  let stage;
  let backup;
  let failure;
  try {
    if ((await readTree(root)).version !== previous.version) {
      throw new Error('Configuration changed since it was read; retry the command');
    }
    stage = await fs.mkdtemp(path.join(root, '.site-config-stage-'));
    for (const dir of [...directories].sort()) {
      if (dir) {
        if (path.isAbsolute(dir) || path.win32.isAbsolute(dir) || dir.includes('\\')
          || dir.split('/').some((part) => ['..', '.', ''].includes(part))) {
          throw new Error('Invalid configuration output directory');
        }
        // eslint-disable-next-line no-await-in-loop
        await fs.mkdir(path.join(stage, dir), { recursive: true });
      }
    }
    for (const [name, file] of files) {
      if (path.isAbsolute(name) || path.win32.isAbsolute(name) || name.includes('\\')
        || name.split('/').some((part) => ['..', '.', ''].includes(part))) {
        throw new Error('Invalid configuration output path');
      }
      const destination = path.join(stage, name);
      // eslint-disable-next-line no-await-in-loop
      await fs.mkdir(path.dirname(destination), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(destination, file.content, { flag: 'wx', mode: file.mode ?? 0o644 });
      if (file.mode !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await fs.chmod(destination, file.mode);
      }
    }
    for (const dir of [...directories].sort().reverse()) {
      if (dir && previous.directoryModes?.has(dir)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.chmod(path.join(stage, dir), previous.directoryModes.get(dir));
      }
    }
    await fs.chmod(stage, previous.mode);
    if ((await readTree(root)).version !== previous.version) {
      throw new Error('Configuration changed while staging; retry the command');
    }
    if (previous.version !== 'missing') {
      const destination = path.join(root, `.site-config-backup-${randomUUID()}`);
      await fs.rename(target, destination);
      backup = destination;
    }
    try {
      if (backup && (await readTree(root, path.basename(backup))).version !== previous.version) {
        throw new Error('Configuration changed before installation; retry the command');
      }
      if ((await readTree(root)).version !== 'missing') {
        throw new Error('Configuration appeared during installation; retry the command');
      }
      await fs.rename(stage, target);
      stage = null;
    } catch (error) {
      if (backup) {
        try {
          if ((await readTree(root)).version !== 'missing') {
            throw new Error('Concurrent configuration exists at the destination; refusing to replace it');
          }
          await fs.rename(backup, target);
          backup = null;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Installation failed; original configuration is preserved at ${backup}`,
          );
        }
      }
      throw error;
    }
    if (backup) {
      if ((await readTree(root, path.basename(backup))).version !== previous.version) {
        throw new Error(`Configuration installed, but a concurrent edit is preserved at ${backup}`);
      }
      try {
        await fs.rm(backup, { recursive: true });
      } catch (error) {
        throw new Error(`Configuration installed, but backup cleanup failed at ${backup}`, { cause: error });
      }
      backup = null;
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await Promise.allSettled([
      stage ? fs.rm(stage, { recursive: true }) : Promise.resolve(),
      (async () => {
        try {
          await lock.close();
        } finally {
          await fs.unlink(lockPath);
        }
      })(),
    ]);
    const errors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) {
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        `${failure?.message || 'Temporary-file cleanup failed'}; inspect ${stage || lockPath}: ${
          errors.map((error) => error.message).join('; ')}`,
      );
    }
  }
  if (failure) {
    throw failure;
  }
}
