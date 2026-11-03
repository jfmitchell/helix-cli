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
/* eslint-disable no-template-curly-in-string */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import YAML from 'yaml';
import ImportCommand from '../../src/config/import.cmd.js';
import ConfigPrompts from '../../src/config/config-prompts.js';
import { importSnapshot, sanitizer } from '../../src/config/config-import.js';
import { loadConfig, prepareConfig } from '../../src/config/config-model.js';
import { planSync } from '../../src/config/config-sync.js';
import { installTree, readTree } from '../../src/config/config-files.js';
import { resetContext } from '../../src/fetch-utils.js';
import {
  cli, fixture, initRepository, logger, MemoryApi, prefix, run, seed, writes,
} from './config-test-utils.js';

describe('deployed organisation config import', function suite() {
  this.timeout(15000);
  let root;
  let api;
  let log;
  let server;
  const command = (options = {}) => {
    const executor = new ImportCommand(log).withDirectory(root).withOptions(options);
    executor.api = api;
    return executor;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-config-import-'));
    await fs.cp(fixture, root, { recursive: true });
    await initRepository(root);
    api = new MemoryApi();
    log = logger();
    await seed(api, await loadConfig(root));
    await fs.rm(path.join(root, 'site-config'), { recursive: true });
  });

  afterEach(async () => {
    sinon.restore();
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      server = null;
    }
    await resetContext();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('imports all users, profiles, site overrides and divergent site queries using only GET', async () => {
    const demo = api.store.get(`${prefix}/sites/demo.json`);
    demo.version = 23;
    demo.apiKeys = { 'live-key': 'synthetic-store-secret' };
    demo.content.contentBusId = 'generated-content-bus';
    demo.cdn.preview = { host: 'preview.example.test' };
    demo.headers = { '/**': [{ key: 'x-example', value: 'site' }] };
    api.store.set(`${prefix}/profiles/another.json`, { title: 'Another profile', version: 4 });
    api.store.set(`${prefix}/sites/second.json`, {
      title: 'Second',
      code: { owner: 'Example', repo: 'website' },
      content: { source: { type: 'sourcebus' } },
      extends: { profile: 'shared' },
    });
    api.store.set(`${prefix}/sites/second/content/query.yaml`, 'indices:\n  other:\n    include:\n      - /news/**\n');
    const snapshot = await importSnapshot(api, 'example');
    await installTree(root, await readTree(root), snapshot.files, snapshot.directories);
    const model = await loadConfig(root);
    assert.equal(model.users.length, 2);
    assert.equal(Object.keys(model.profiles).length, 2);
    assert.equal(Object.keys(model.sites).length, 2);
    assert.deepEqual(model.sites.demo.doc.extends, { profile: 'shared' });
    assert.ok(model.sites.demo.query.data.indices.pages);
    assert.ok(model.sites.second.query.data.indices.other);
    assert.equal(model.profiles.shared.query, null);
    assert.equal(model.sites.demo.doc.cdn.preview.host, 'preview.example.test');
    assert.ok(snapshot.files.has('sites/demo/headers.json'));
    assert.ok(snapshot.files.has('sites/demo/access.json'));
    assert.ok(snapshot.files.has('sites/demo/cdn/prod.json'));
    assert.ok(snapshot.files.has('sites/demo/robots.txt'));
    assert.ok(snapshot.files.has('sites/demo/content/sitemap.yaml'));
    assert.ok(!snapshot.files.has('sites/second/content/sitemap.yaml'));
    assert.equal(model.sites.demo.doc.content.contentBusId, undefined);
    assert.equal(model.sites.demo.doc.version, undefined);
    assert.equal(model.users[0].id, undefined);
    assert.ok([...snapshot.files.values()].every(({ content }) => !content.includes('synthetic-store-secret')));
    assert.deepEqual(writes(api), []);
    api.calls.splice(0);
    assert.deepEqual(await planSync(api, prepareConfig(model, {})), []);
    assert.deepEqual(writes(api), []);
  });

  it('sanitizes document, header, URL and YAML secrets and round-trips with supplied variables', async () => {
    const demo = api.store.get(`${prefix}/sites/demo.json`);
    demo.cdn.prod.authToken = 'synthetic-cdn-secret';
    demo.access.admin.apiKeyId = ['ci-key'];
    demo.content.source = { type: 'markup', url: 'https://content.example.test/?token=synthetic-url-secret' };
    demo.headers = {};
    demo.headers['/private/**'] = [
      { key: 'Authorization', value: 'Bearer synthetic-header-secret' },
      { name: 'X-API-Key', value: 'synthetic-key-secret' },
    ];
    demo.headers['/all/**'] = { Cookie: 'synthetic-cookie-secret', 'X-API-Key': 'synthetic-map-secret' };
    const profile = api.store.get(`${prefix}/profiles/shared.json`);
    profile.sidekick = { credentials: { clientSecret: 'synthetic-profile-secret' } };
    const queryPath = `${prefix}/sites/demo/content/query.yaml`;
    const query = YAML.parse(api.store.get(queryPath));
    query.authToken = 'synthetic-query-secret';
    api.store.set(queryPath, YAML.stringify(query));
    const snapshot = await importSnapshot(api, 'example');
    await command().run();
    const model = await loadConfig(root);
    const env = { AEM_CI_KEY_ID: 'ci-key' };
    const collect = (sanitized, original) => {
      if (typeof sanitized === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(sanitized)) {
        env[sanitized.slice(2, -1)] = original;
      } else if (sanitized && typeof sanitized === 'object') {
        Object.entries(sanitized).forEach(([key, value]) => collect(value, original[key]));
      }
    };
    collect(model.sites.demo.doc, demo);
    collect(model.profiles.shared.doc, profile);
    collect(model.sites.demo.query.data, query);
    assert.deepEqual(snapshot.variables, Object.keys(env).filter((name) => name !== 'AEM_CI_KEY_ID').sort());
    assert.equal(snapshot.variables.length, 8);
    assert.ok(snapshot.variables.every((name) => name.startsWith('AEM_CONFIG_')));
    const contents = [...(await readTree(root)).files.values()].map(({ content }) => content.toString()).join('\n');
    const output = [...log.info.args, ...log.warn.args].flat().join('\n');
    assert.ok(!contents.includes('synthetic-'));
    assert.ok(!output.includes('synthetic-'));
    assert.match(contents, /\$\{AEM_CONFIG_/);
    assert.deepEqual(model.sites.demo.doc.access.admin.apiKeyId, ['ci-key']);
    assert.deepEqual(writes(api), []);
    assert.throws(() => prepareConfig(model, { AEM_CI_KEY_ID: 'ci-key' }), /Missing environment variable/);
    api.calls.splice(0);
    assert.deepEqual(await planSync(api, prepareConfig(model, env)), []);
    assert.deepEqual(writes(api), []);
  });

  it('skips only absent optional query and sitemap endpoints', async () => {
    api.store.delete(`${prefix}/sites/demo/content/query.yaml`);
    api.store.delete(`${prefix}/sites/demo/content/sitemap.yaml`);
    const snapshot = await importSnapshot(api, 'example');
    assert.equal(snapshot.model.sites.demo.query, null);
    assert.equal(snapshot.model.sites.demo.sitemap, null);
    assert.ok(!snapshot.files.has('sites/demo/content/query.yaml'));
  });

  it('previews a new import without creating directories or files', async () => {
    await command({ dryRun: true }).run();
    assert.equal((await readTree(root)).version, 'missing');
    assert.ok(log.info.calledWithMatch('Import organisation example'));
    assert.ok(log.info.calledWithMatch('add org/users.json'));
    assert.deepEqual(writes(api), []);
  });

  it('previews removals but refuses an existing tree without explicit overwrite, even with yes', async () => {
    await fs.mkdir(path.join(root, 'site-config'));
    await fs.writeFile(path.join(root, 'site-config/local-note.txt'), 'local work');
    const previous = await readTree(root);
    await command({ dryRun: true }).run();
    await assert.rejects(command({ yes: true }).run(), /use --overwrite/);
    assert.ok(log.info.calledWithMatch('remove local-note.txt'));
    assert.equal((await readTree(root)).version, previous.version);
    assert.deepEqual(writes(api), []);
  });

  it('requires confirmation for overwrite and leaves a declined preview unchanged', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const previous = await readTree(root);
    const executor = command({ overwrite: true });
    executor.prompts = new ConfigPrompts(log, {}, {});
    await assert.rejects(executor.run(), /--overwrite --yes/);
    sinon.stub(executor.prompts, 'confirm').rejects(new Error('Configuration operation cancelled'));
    await assert.rejects(executor.run(), /cancelled/);
    assert.equal((await readTree(root)).version, previous.version);
    assert.deepEqual(writes(api), []);
  });

  it('replaces the local tree only with explicit overwrite and confirmation', async () => {
    await fs.cp(fixture, root, { recursive: true });
    await fs.writeFile(path.join(root, 'site-config/local-note.txt'), 'old local config');
    await fs.writeFile(path.join(root, 'untouched.txt'), 'not config');
    await command({ overwrite: true, yes: true }).run();
    assert.ok(!(await readTree(root)).files.has('local-note.txt'));
    assert.equal(await fs.readFile(path.join(root, 'untouched.txt'), 'utf8'), 'not config');
    await loadConfig(root);
    assert.deepEqual(writes(api), []);
    assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.site-config-')));
  });

  it('rejects changes made while the replacement preview is awaiting confirmation', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const executor = command({ overwrite: true });
    sinon.stub(executor.prompts, 'confirm').callsFake(async () => {
      await fs.writeFile(path.join(root, 'site-config/local-note.txt'), 'new local work');
    });
    await assert.rejects(executor.run(), /changed since/);
    assert.equal(await fs.readFile(path.join(root, 'site-config/local-note.txt'), 'utf8'), 'new local work');
  });

  [
    ['paginated sites', 'sites', { sites: ['demo'], next: 'next' }],
    ['incomplete profiles', 'profiles', { profiles: ['shared'], total: 2 }],
    ['malformed users', 'users', { users: [{ email: 'invalid', roles: ['admin'] }] }],
    ['duplicate sites', 'sites', { sites: ['demo', 'demo'] }],
    ['duplicate users', 'users', {
      users: [
        { email: 'a@example.test', roles: ['admin'] }, { email: 'A@example.test', roles: ['admin'] },
      ],
    }],
    ['invalid resource path', 'sites', { sites: ['../outside'] }],
  ].forEach(([label, key, inventory]) => {
    it(`rejects ${label} without writing a partial import`, async () => {
      api.inventories[`${prefix}/${key}.json`] = inventory;
      await assert.rejects(command().run(), /Admin API/);
      assert.equal((await readTree(root)).version, 'missing');
      assert.deepEqual(writes(api), []);
    });
  });

  ['sites/demo', 'profiles/shared'].forEach((resource) => {
    it(`rejects disappearance of listed ${resource}`, async () => {
      const get = api.get.bind(api);
      sinon.stub(api, 'get').callsFake(async (url, allowMissing) => (
        url === `${prefix}/${resource}.json` ? { status: 404 } : get(url, allowMissing)
      ));
      await assert.rejects(command().run(), /disappeared/);
      assert.equal((await readTree(root)).version, 'missing');
    });
  });

  it('detects inventory churn and user-role changes before installation', async () => {
    let reads = 0;
    api.inventories[`${prefix}/sites.json`] = () => {
      reads += 1;
      return { sites: reads === 1 ? ['demo'] : ['demo', 'new'] };
    };
    await assert.rejects(command().run(), /inventory changed/);
    delete api.inventories[`${prefix}/sites.json`];
    reads = 0;
    api.inventories[`${prefix}/users.json`] = () => {
      const users = structuredClone(api.users);
      reads += 1;
      if (reads > 1) {
        users[0].roles = ['author'];
      }
      return users;
    };
    await assert.rejects(command().run(), /inventory changed/);
    assert.equal((await readTree(root)).version, 'missing');
  });

  it('fails before replacing local work on request errors or unsupported documents', async () => {
    await fs.cp(fixture, root, { recursive: true });
    const before = await readTree(root);
    api.fail = `GET ${prefix}/profiles/shared.json`;
    await assert.rejects(command({ overwrite: true, yes: true }).run(), /Simulated read failure/);
    api.fail = null;
    api.store.set(`${prefix}/sites/demo.json`, []);
    await assert.rejects(command({ overwrite: true, yes: true }).run(), /configuration object/);
    assert.equal((await readTree(root)).version, before.version);
    assert.deepEqual(writes(api), []);
  });

  it('rejects broken inheritance, malformed YAML, incomplete config and non-string secrets', async () => {
    const demo = api.store.get(`${prefix}/sites/demo.json`);
    demo.extends.profile = 'missing';
    await assert.rejects(command().run(), /unknown profile/);
    demo.extends.profile = 'shared';
    const queryPath = `${prefix}/sites/demo/content/query.yaml`;
    api.store.set(queryPath, 'indices: [');
    await assert.rejects(command().run(), /invalid YAML/);
    api.store.delete(queryPath);
    demo.cdn.prod.authToken = 123456;
    await assert.rejects(command().run(), /secret values must be strings/);
    delete demo.cdn.prod.authToken;
    api.users = [];
    await assert.rejects(command().run(), /nonempty array of users/);
    assert.equal((await readTree(root)).version, 'missing');
  });

  it('runs the real import command against a GET-only local Admin API using cwd credentials', async () => {
    server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'GET');
        assert.equal(req.headers.authorization, 'token synthetic-admin-token');
        const response = await api.get(req.url, true);
        res.writeHead(response.status, {
          'content-type': req.url.endsWith('.yaml') ? 'text/yaml' : 'application/json',
        });
        res.end(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    await fs.writeFile(path.join(root, '.dev.vars'), [
      'AEM_ADMIN_TOKEN=synthetic-admin-token',
      `AEM_ADMIN_BASE=http://127.0.0.1:${server.address().port}`,
    ].join('\n'));
    const env = { ...process.env, NO_PROXY: '127.0.0.1' };
    delete env.AEM_ADMIN_TOKEN;
    delete env.AEM_ADMIN_BASE;
    const { stdout, stderr } = await run(process.execPath, [cli, 'config', 'import'], { cwd: root, env });
    assert.match(`${stdout}${stderr}`, /Imported deployed configuration/);
    await loadConfig(root);
    assert.deepEqual(writes(api), []);
  });
});

describe('import secret placeholders', () => {
  it('uses deterministic collision-free names and reserves existing placeholders', () => {
    const values = {
      'one-two': { password: 'synthetic-first' },
      one_two: { password: 'synthetic-second' },
      existing: { token: '${AEM_CONFIG_SITE_ONE_TWO_PASSWORD}' },
    };
    const first = sanitizer();
    first.reserve(values);
    const output = first.sanitize(values, ['SITE']);
    assert.equal(output['one-two'].password, '${AEM_CONFIG_SITE_ONE_TWO_PASSWORD_2}');
    assert.equal(output.one_two.password, '${AEM_CONFIG_SITE_ONE_TWO_PASSWORD_3}');
    assert.equal(output.existing.token, '${AEM_CONFIG_SITE_ONE_TWO_PASSWORD}');
    assert.equal(first.variables.size, 3);
    const second = sanitizer();
    second.reserve(values);
    assert.deepEqual(second.sanitize(values, ['SITE']), output);
  });

  it('does not report unused embedded placeholders masked by a whole-secret replacement', () => {
    const input = { Authorization: 'Bearer ${EXISTING_TOKEN}' };
    const processor = sanitizer();
    processor.reserve(input);
    const output = processor.sanitize(input, ['SITE']);
    assert.equal(output.Authorization, '${AEM_CONFIG_SITE_AUTHORIZATION}');
    assert.deepEqual([...processor.variables], ['AEM_CONFIG_SITE_AUTHORIZATION']);
  });
});
