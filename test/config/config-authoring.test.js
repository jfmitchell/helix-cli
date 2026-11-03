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
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import esmock from 'esmock';
import AddCommand from '../../src/config/add.cmd.js';
import ConfigPrompts from '../../src/config/config-prompts.js';
import { loadConfig } from '../../src/config/config-model.js';
import { fileChanges, installTree, readTree } from '../../src/config/config-files.js';
import {
  cli, fixture, initRepository, logger, run,
} from './config-test-utils.js';

describe('repository config authoring', function suite() {
  this.timeout(15000);
  let root;
  let log;
  const add = (kind, options) => new AddCommand(log, kind)
    .withDirectory(root).withOptions(options);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-config-add-'));
    await initRepository(root);
    log = logger();
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('bootstraps minimal profiles, sites and users without prompting or network credentials', async () => {
    sinon.stub(readline, 'createInterface').throws(new Error('Unexpected prompt'));
    await add('profile', { name: 'shared' }).run();
    await add('site', { name: 'demo', profile: 'shared' }).run();
    await add('user', { email: 'admin@example.test', roles: ['admin', 'author,admin'] }).run();
    const tree = await readTree(root);
    assert.deepEqual([...tree.files.keys()], [
      'org/users.json', 'profiles/shared/profile.json', 'sites/demo/site.json',
    ]);
    const model = await loadConfig(root);
    assert.deepEqual(model.profiles.shared.doc, { title: 'shared' });
    assert.deepEqual(model.sites.demo.doc, {
      title: 'demo',
      code: { owner: 'Example', repo: 'website' },
      content: { source: { type: 'sourcebus' } },
      extends: { profile: 'shared' },
    });
    assert.deepEqual(model.users, [{ email: 'admin@example.test', roles: ['admin', 'author'] }]);
    assert.ok(log.warn.calledWithMatch('Before deploying'));
  });

  it('supports every external source and explicit titles', async () => {
    for (const sourceType of ['markup', 'google', 'onedrive']) {
      // eslint-disable-next-line no-await-in-loop
      await add('site', {
        name: sourceType, title: 'Content site', sourceType, sourceUrl: 'https://content.example.test',
      }).run();
    }
    const model = await loadConfig(root, { allowIncomplete: true });
    assert.equal(model.sites.markup.doc.title, 'Content site');
    assert.deepEqual(model.sites.google.doc.content.source, {
      type: 'google', url: 'https://content.example.test',
    });
    await assert.rejects(loadConfig(root), /nonempty array/);
  });

  it('preserves existing file bytes, users and permissions', async () => {
    await fs.cp(fixture, root, { recursive: true });
    await fs.chmod(path.join(root, 'site-config/org'), 0o700);
    await fs.chmod(path.join(root, 'site-config/org/users.json'), 0o600);
    const before = await readTree(root);
    await add('profile', { name: 'another', title: 'Another profile' }).run();
    const after = await readTree(root);
    assert.deepEqual(fileChanges(before.files, after.files), ['add profiles/another/profile.json']);
    assert.equal(after.directoryModes.get('org'), 0o700);
    assert.equal(after.files.get('org/users.json').mode, 0o600);
    await add('user', { email: 'new@example.test', roles: 'publish author' }).run();
    const model = await loadConfig(root);
    assert.equal(model.users.length, 3);
    assert.deepEqual(model.users[2], { email: 'new@example.test', roles: ['publish', 'author'] });
    assert.equal((await readTree(root)).files.get('org/users.json').mode, 0o600);
  });

  it('rejects duplicate sites, profiles and case-insensitive users without modifying the tree', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const before = await readTree(root);
    for (const [kind, options] of [
      ['site', { name: 'demo' }],
      ['profile', { name: 'shared' }],
      ['user', { email: 'ADMIN@example.test', roles: ['admin'] }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(add(kind, options).run(), /already exists/);
    }
    assert.equal((await readTree(root)).version, before.version);
  });

  [
    ['traversal', 'site', { name: '../outside' }, /invalid identifier/],
    ['missing profile', 'site', { name: 'demo', profile: 'absent' }, /profile does not exist/],
    ['invalid profile', 'site', { name: 'demo', profile: '../outside' }, /invalid identifier/],
    ['unknown source', 'site', { name: 'demo', sourceType: 'unknown' }, /Unknown content/],
    ['sourcebus URL', 'site', { name: 'demo', sourceUrl: 'https://example.test' }, /external/],
    ['bad source URL', 'site', { name: 'demo', sourceType: 'markup', sourceUrl: 'bad' }, /valid --source-url/],
    ['credentials in URL', 'site', { name: 'demo', sourceType: 'markup', sourceUrl: 'https://user:password@example.test' }, /embedded credentials/],
    ['invalid roles', 'user', { email: 'a@example.test', roles: ['invalid'] }, /Roles/],
    ['empty roles', 'user', { email: 'a@example.test', roles: [] }, /Roles/],
    ['invalid email', 'user', { email: 'invalid', roles: ['author'] }, /valid user email/],
    ['bad title', 'profile', { name: 'shared', title: 123 }, /expected a string/],
  ].forEach(([label, kind, options, error]) => {
    it(`rejects ${label} before creating any files`, async () => {
      await assert.rejects(add(kind, options).run(), error);
      assert.equal((await readTree(root)).version, 'missing');
    });
  });

  it('reports all missing non-terminal inputs and never grants an implicit role', async () => {
    const command = add('user', {});
    command.prompts = new ConfigPrompts(log, {}, {});
    await assert.rejects(command.run(), /\[email\], --roles/);
    command.withOptions({ email: 'a@example.test' });
    await assert.rejects(command.run(), /--roles/);
    const site = add('site', { sourceType: 'markup' });
    site.prompts = command.prompts;
    await assert.rejects(site.run(), /\[name\], --source-url/);
    assert.equal((await readTree(root)).version, 'missing');
  });

  it('collects only missing mandatory inputs and leaves no partial files on cancellation', async () => {
    const command = add('user', {});
    command.prompts = new ConfigPrompts(log, { isTTY: true }, { isTTY: true });
    const ask = sinon.stub(command.prompts, 'ask');
    ask.onFirstCall().callsFake(async (question, validate) => validate('new@example.test'));
    ask.onSecondCall().rejects(new Error('Configuration operation cancelled'));
    await assert.rejects(command.run(), /cancelled/);
    assert.equal((await readTree(root)).version, 'missing');
    ask.resetBehavior();
    ask.callsFake(async (question, validate) => validate('author publish'));
    command.withOptions({ email: 'new@example.test' });
    await command.run();
    assert.equal(ask.callCount, 3);
    assert.deepEqual((await loadConfig(root, { allowIncomplete: true })).users, [
      { email: 'new@example.test', roles: ['author', 'publish'] },
    ]);
  });

  it('does not hide malformed existing files or broken references as an empty bootstrap', async () => {
    await fs.cp(fixture, root, { recursive: true });
    await fs.writeFile(path.join(root, 'site-config/org/users.json'), '{ invalid json');
    const previous = await readTree(root);
    await assert.rejects(add('user', { email: 'new@example.test', roles: ['author'] }).run(), /invalid JSON/);
    assert.equal((await readTree(root)).version, previous.version);
    await fs.writeFile(path.join(root, 'site-config/org/users.json'), '[]');
    await fs.rm(path.join(root, 'site-config/profiles/shared/profile.json'));
    await assert.rejects(add('profile', { name: 'new' }).run(), /missing profile.json/);
  });

  it('supports the public command hierarchy and rejects old or unsupported flags', async () => {
    const options = { cwd: root, timeout: 7000 };
    await run(process.execPath, [cli, 'config', 'profile', 'add', 'shared'], options);
    await run(process.execPath, [cli, 'config', 'site', 'add', 'demo', '--profile', 'shared'], options);
    await run(process.execPath, [cli, 'config', 'user', 'add', 'admin@example.test', '--roles', 'admin', 'author'], options);
    assert.equal((await loadConfig(root)).users[0].roles.length, 2);
    await assert.rejects(run(process.execPath, [cli, 'config', 'sync'], options), /Unknown/);
    await assert.rejects(run(process.execPath, [cli, 'config', 'site', 'add', 'new', '--root', root], options), /Unknown argument/);
    await assert.rejects(run(process.execPath, [cli, 'config', 'profile', 'add', 'new', '--overwrite'], options), /Unknown argument/);
    await assert.rejects(run(process.execPath, [cli, 'config', 'user', 'add'], options), /Missing mandatory inputs/);
  });

  [['deploy'], ['import'], ['site', 'add'], ['profile', 'add'], ['user', 'add']].forEach((args) => {
    it(`shows help for config ${args.join(' ')} without credentials`, async () => {
      const { stdout } = await run(process.execPath, [cli, 'config', ...args, '--help'], { cwd: root });
      assert.match(stdout, new RegExp(`aem config ${args.join(' ')}`));
    });
  });

  it('rejects symlinked config roots and nested entries', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'site-config'));
    await assert.rejects(add('profile', { name: 'new' }).run(), /symlink/);
    await fs.unlink(path.join(root, 'site-config'));
    await fs.cp(fixture, root, { recursive: true });
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'site-config/sites/link'));
    await assert.rejects(add('profile', { name: 'new' }).run(), /symlink/);
  });

  it('rejects concurrent writes captured before prompting', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const command = add('profile', {});
    command.prompts = new ConfigPrompts(log, { isTTY: true }, { isTTY: true });
    sinon.stub(command.prompts, 'ask').callsFake(async () => {
      await fs.writeFile(path.join(root, 'site-config/local-note.txt'), 'external edit');
      return 'new';
    });
    await assert.rejects(command.run(), /changed since/);
    assert.equal(await fs.readFile(path.join(root, 'site-config/local-note.txt'), 'utf8'), 'external edit');
    assert.ok(!(await readTree(root)).files.has('profiles/new/profile.json'));
  });

  it('rejects locks and unsafe output paths and removes its own staging files', async () => {
    const previous = await readTree(root);
    await fs.writeFile(path.join(root, '.site-config.lock'), 'existing writer');
    await assert.rejects(installTree(root, previous, new Map()), /Another config writer/);
    await fs.unlink(path.join(root, '.site-config.lock'));
    for (const name of ['../outside', '/absolute', 'C:\\outside', 'folder\\file', './file']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(installTree(root, previous, new Map([[name, { content: 'no' }]])), /Invalid configuration output path/);
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(installTree(root, previous, new Map(), new Set([name])), /Invalid configuration output directory/);
    }
    assert.deepEqual(await fs.readdir(root), ['.git']);
  });

  it('restores the original tree when staged installation fails', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const previous = await readTree(root);
    const rename = sinon.spy(async (from, to) => {
      if (path.basename(from).startsWith('.site-config-stage-')) {
        throw new Error('Simulated installation failure');
      }
      return fs.rename(from, to);
    });
    const mocked = await esmock('../../src/config/config-files.js', {
      'node:fs/promises': { rename },
    });
    await assert.rejects(mocked.installTree(root, previous, new Map([['new.json', { content: '{}' }]])), /Simulated installation failure/);
    assert.equal((await readTree(root)).version, previous.version);
    assert.equal(rename.callCount, 3);
    assert.deepEqual((await fs.readdir(root)).sort(), ['.git', 'site-config']);
  });

  it('attempts lock cleanup even when staging cleanup fails and preserves both errors', async () => {
    const previous = await readTree(root);
    const mocked = await esmock('../../src/config/config-files.js', {
      'node:fs/promises': {
        writeFile: async () => { throw new Error('write failure'); },
        rm: async () => { throw new Error('cleanup failure'); },
      },
    });
    await assert.rejects(mocked.installTree(root, previous, new Map([['new.json', { content: '{}' }]])), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((cause) => cause.message), ['write failure', 'cleanup failure']);
      return true;
    });
    assert.ok(!(await fs.readdir(root)).includes('.site-config.lock'));
  });

  it('keeps concurrent destination work and the original backup if rollback cannot safely restore', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const previous = await readTree(root);
    const mocked = await esmock('../../src/config/config-files.js', {
      'node:fs/promises': {
        rename: async (from, to) => {
          if (path.basename(from).startsWith('.site-config-stage-')) {
            await fs.mkdir(to);
            await fs.writeFile(path.join(to, 'external.txt'), 'concurrent work');
            throw new Error('Simulated installation failure');
          }
          return fs.rename(from, to);
        },
      },
    });
    await assert.rejects(mocked.installTree(root, previous, new Map([['new.json', { content: '{}' }]])), /original configuration is preserved/);
    assert.equal(await fs.readFile(path.join(root, 'site-config/external.txt'), 'utf8'), 'concurrent work');
    const backup = (await fs.readdir(root)).find((name) => name.startsWith('.site-config-backup-'));
    assert.equal((await readTree(root, backup)).version, previous.version);
    assert.ok(!(await fs.readdir(root)).includes('.site-config.lock'));
  });

  it('rejects edits occurring during staging and keeps the edited original', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const previous = await readTree(root);
    const mocked = await esmock('../../src/config/config-files.js', {
      'node:fs/promises': {
        writeFile: async (...args) => {
          await fs.writeFile(path.join(root, 'site-config/external.txt'), 'concurrent work');
          return fs.writeFile(...args);
        },
      },
    });
    await assert.rejects(mocked.installTree(root, previous, new Map([['new.json', { content: '{}' }]])), /changed while staging/);
    assert.equal(await fs.readFile(path.join(root, 'site-config/external.txt'), 'utf8'), 'concurrent work');
    assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.site-config-')));
  });
});

describe('config prompts', () => {
  let input;
  let output;
  let prompts;
  let log;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    log = logger();
    prompts = new ConfigPrompts(log, input, output);
  });

  afterEach(() => {
    input.destroy();
    output.destroy();
    sinon.restore();
  });

  it('retries invalid input and closes readline after a valid answer', async () => {
    const pending = prompts.ask('Name', (value) => {
      if (value !== 'valid') {
        throw new Error('Invalid name');
      }
      return value;
    });
    input.write('invalid\n');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    input.write(' valid \n');
    assert.equal(await pending, 'valid');
    assert.ok(log.warn.calledWith('Invalid name'));
    assert.equal(input.listenerCount('keypress'), 0);
  });

  [
    ['EOF', (stream) => stream.end()],
    ['Ctrl-C', (stream) => stream.write('\x03')],
  ].forEach(([label, cancel]) => {
    it(`cancels cleanly on ${label}`, async () => {
      const pending = prompts.ask('Name');
      cancel(input);
      await assert.rejects(pending, /cancelled/);
      assert.equal(input.listenerCount('keypress'), 0);
    });
  });

  it('requires affirmative confirmation and explicit yes in non-terminal scripts', async () => {
    const declined = prompts.confirm('Replace?');
    input.write('n\n');
    await assert.rejects(declined, /cancelled/);
    const confirmed = prompts.confirm('Replace?');
    input.write('yes\n');
    await confirmed;
    input.isTTY = false;
    await assert.rejects(prompts.confirm('Replace?'), /--overwrite --yes/);
    await assert.rejects(prompts.ask('Name'), /Missing input/);
    await prompts.confirm('Replace?', true);
  });
});
