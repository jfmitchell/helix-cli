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
/* eslint-env mocha */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sinon from 'sinon';
import {
  loadConfig, prepareConfig, configEnvironment, parseYaml,
} from '../../src/config/config-model.js';
import { planSync, syncConfig } from '../../src/config/config-sync.js';
import AdminApi from '../../src/config/admin-api.js';
import DeployCommand from '../../src/config/deploy.cmd.js';
import config from '../../src/config/config.js';
import deploy from '../../src/config/deploy.js';
import { resetContext } from '../../src/fetch-utils.js';

import {
  run, fixture, cli, prefix, MemoryApi, logger, seed, writes, addExtras, initRepository,
} from './config-test-utils.js';

describe('repository config deployment', () => {
  let root;
  let model;
  let api;
  let log;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-config-test-'));
    await fs.cp(fixture, root, { recursive: true });
    await initRepository(root);
    model = await loadConfig(root);
    api = new MemoryApi();
    log = logger();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    sinon.restore();
    await resetContext();
  });

  it('loads the existing repository layout and composes split site config', () => {
    assert.equal(model.org, 'example');
    assert.equal(model.users.length, 2);
    assert.equal(model.sites.demo.doc.cdn.prod.host, 'www.example.test');
    assert.ok(model.sites.demo.doc.robots.txt.includes('Sitemap:'));
    assert.deepEqual(model.sites.demo.doc.access.admin.role.admin, ['admin@example.test']);
    assert.ok(model.profiles.shared.query.data.indices.pages);
    assert.ok(model.sites.demo.sitemap.data.sitemaps.default);
  });

  it('prefers a site query over its profile and supports queries without profiles', async () => {
    const queryFile = path.join(root, 'site-config/sites/demo/content/query.yaml');
    await fs.writeFile(queryFile, 'indices:\n  override:\n    include:\n      - /news/**\n');
    model = await loadConfig(root);
    await seed(api, model);
    assert.ok(api.store.get(`${prefix}/sites/demo/content/query.yaml`).includes('override'));
    await syncConfig(api, prepareConfig(model, {}), { dryRun: true, log });
    assert.deepEqual(writes(api), []);
    delete model.sites.demo.doc.extends;
    await syncConfig(api, model, { log });
    assert.ok(api.store.get(`${prefix}/sites/demo/content/query.yaml`).includes('override'));
    api.calls.splice(0);
    model.sites.demo.query = null;
    await syncConfig(api, model, { log });
    assert.ok(!api.calls.some((call) => call.resource.endsWith('/content/query.yaml')));
  });

  it('keeps shared profile queries for sites without an explicit override', async () => {
    model.sites.second = structuredClone(model.sites.demo);
    delete model.sites.second.doc.cdn;
    model.sites.second.sitemap = null;
    model.sites.demo.query = { text: 'indices:\n  local: {}\n', data: { indices: { local: {} } } };
    await seed(api, model);
    model.profiles.shared.query = { text: 'indices:\n  updated: {}\n', data: { indices: { updated: {} } } };
    await syncConfig(api, model, { log });
    assert.ok(api.store.get(`${prefix}/sites/second/content/query.yaml`).includes('updated'));
    assert.ok(api.store.get(`${prefix}/sites/demo/content/query.yaml`).includes('local'));
  });

  it('derives the lowercased organisation from HTTPS and SSH origin URLs', async () => {
    for (const origin of [
      'https://github.com/Example/website.git',
      'git@github.com:Example/website.git',
      'ssh://git@github.com/Example/website.git',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await run('git', ['remote', 'set-url', 'origin', origin], { cwd: root });
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await loadConfig(root)).org, 'example');
    }
  });

  it('uses origin rather than upstream', async () => {
    await run(
      'git',
      ['remote', 'add', 'upstream', 'https://github.com/Another/website.git'],
      { cwd: root },
    );
    assert.equal((await loadConfig(root)).org, 'example');
  });

  it('rejects missing, invalid and local origins before network access', async () => {
    await run('git', ['remote', 'remove', 'origin'], { cwd: root });
    await assert.rejects(new DeployCommand(log).withDirectory(root).run(), /Git origin remote/);
    await assert.rejects(loadConfig(fixture), /Git origin remote/);
    await run('git', ['remote', 'add', 'origin', 'invalid'], { cwd: root });
    for (const origin of ['invalid', '/tmp/website', 'file:///tmp/website']) {
      // eslint-disable-next-line no-await-in-loop
      await run('git', ['remote', 'set-url', 'origin', origin], { cwd: root });
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(new DeployCommand(log).withDirectory(root).run(), /Git origin/);
    }
  });

  it('creates users, profiles, sites and YAML definitions in dependency order', async () => {
    await syncConfig(api, model, { log });
    assert.deepEqual(writes(api).map((call) => call.method), [
      'POST', 'POST', 'PUT', 'PUT', 'PUT', 'PUT',
    ]);
    assert.equal(api.store.get(`${prefix}/sites/demo.json`).extends.profile, 'shared');
    assert.equal(
      api.store.get(`${prefix}/sites/demo/content/query.yaml`),
      model.profiles.shared.query.text,
    );
    assert.ok(api.calls.every((call) => call.resource.startsWith(`${prefix}/`)));
  });

  it('is idempotent and ignores JSON key and user role ordering', async () => {
    await seed(api, model);
    api.users[0].roles.reverse();
    api.store.set(`${prefix}/profiles/shared.json`, {
      metadata: model.profiles.shared.doc.metadata,
      headers: model.profiles.shared.doc.headers,
    });
    assert.deepEqual(await planSync(api, model), []);
  });

  it('preserves unmanaged fields, contentBusId and access while updating site documents', async () => {
    await seed(api, model);
    const live = api.store.get(`${prefix}/sites/demo.json`);
    live.secrets = { untouched: 'private-value' };
    live.apiKeys = { untouched: 'private-key' };
    live.version = 12;
    live.content.contentBusId = 'generated';
    live.title = 'Old title';
    live.access = { admin: { role: { admin: ['old@example.test'] } } };
    api.store.get(`${prefix}/profiles/shared.json`).secrets = { untouched: true };
    model.profiles.shared.doc.title = 'New profile title';
    await syncConfig(api, model, { log });
    const siteWrite = writes(api).find((call) => call.resource === `${prefix}/sites/demo.json`);
    assert.deepEqual(siteWrite.body.access, { admin: { role: { admin: ['old@example.test'] } } });
    assert.equal(siteWrite.body.content.contentBusId, 'generated');
    assert.deepEqual(siteWrite.body.secrets, { untouched: 'private-value' });
    assert.deepEqual(siteWrite.body.apiKeys, { untouched: 'private-key' });
    assert.equal(siteWrite.body.version, 12);
    assert.equal(writes(api).at(-1).resource, `${prefix}/sites/demo/access.json`);
    assert.deepEqual(api.store.get(`${prefix}/profiles/shared.json`).secrets, { untouched: true });
    assert.deepEqual(await planSync(api, model), []);
  });

  it('fans out profile query updates to every extending site', async () => {
    model.sites.second = structuredClone(model.sites.demo);
    await seed(api, model);
    model.profiles.shared.query = {
      text: 'indices: { changed: {} }\n',
      data: { indices: { changed: {} } },
    };
    await syncConfig(api, model, { log });
    assert.deepEqual(writes(api).map((call) => call.resource), [
      `${prefix}/sites/demo/content/query.yaml`,
      `${prefix}/sites/second/content/query.yaml`,
    ]);
  });

  it('does not delete extra users, profiles or sites by default', async () => {
    await seed(api, model);
    addExtras(api);
    await syncConfig(api, model, { log });
    assert.equal(writes(api).length, 0);
    assert.ok(api.store.has(`${prefix}/sites/extra.json`));
    assert.ok(api.store.has(`${prefix}/profiles/extra.json`));
    assert.ok(api.users.some((user) => user.id === 'extra'));
  });

  it('prunes extra sites before profiles and users, after retained resources reconcile', async () => {
    await seed(api, model);
    addExtras(api);
    model.sites.demo.doc.title = 'Updated';
    await syncConfig(api, model, { prune: true, log });
    assert.deepEqual(writes(api).map((call) => [call.method, call.resource]), [
      ['POST', `${prefix}/sites/demo.json`],
      ['DELETE', `${prefix}/sites/extra.json`],
      ['DELETE', `${prefix}/profiles/extra.json`],
      ['DELETE', `${prefix}/users/extra.json`],
    ]);
    assert.ok(api.users.some((user) => user.roles.includes('admin')));
  });

  it('dry-run previews creates, updates and deletes without any mutation', async () => {
    addExtras(api);
    await syncConfig(api, model, { dryRun: true, prune: true, log });
    assert.equal(writes(api).length, 0);
    const output = log.info.args.flat().join('\n');
    assert.match(output, /\[dry-run\] user .*: create/);
    assert.match(output, /profile extra: delete/);
    assert.match(output, /site extra: delete/);
    assert.match(output, /user extra@.*: delete/);
    assert.match(output, /Configuration deployment: example/);
  });

  it('does not prune or report success after a reconciliation failure', async () => {
    addExtras(api);
    api.fail = `${prefix}/profiles/shared.json`;
    await assert.rejects(syncConfig(api, model, { prune: true, log }), /Simulated/);
    assert.ok(writes(api).every((call) => call.method !== 'DELETE'));
    assert.ok(!log.info.args.flat().some((line) => line.startsWith('Applied')));
  });

  it('rejects malformed and paginated inventories before any writes', async () => {
    for (const data of [
      {}, null, { sites: [], next: 'cursor' }, { sites: [], total: 10 },
      { sites: [{ name: '../unsafe' }] }, { sites: ['duplicate', 'duplicate'] },
    ]) {
      api.inventories[`${prefix}/sites.json`] = data;
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(syncConfig(api, model, { prune: true, log }));
      assert.equal(writes(api).length, 0);
    }
  });

  it('rejects malformed users and profile inventories before any writes', async () => {
    api.inventories[`${prefix}/profiles.json`] = { unexpected: [] };
    await assert.rejects(syncConfig(api, model, { prune: true, log }), /inventory/);
    api.inventories = { [`${prefix}/users.json`]: [{ email: 'user@example.test', roles: [] }] };
    await assert.rejects(syncConfig(api, model, { prune: true, log }), /ID/);
    assert.equal(writes(api).length, 0);
  });

  it('preflights live document and YAML failures before any write', async () => {
    api.store.set(`${prefix}/sites/demo.json`, []);
    await assert.rejects(syncConfig(api, model, { prune: true, log }), /configuration object/);
    api.store.set(`${prefix}/sites/demo.json`, {});
    api.store.set(`${prefix}/sites/demo/content/query.yaml`, 'indices: [');
    await assert.rejects(syncConfig(api, model, { log }), /invalid YAML/);
    assert.equal(writes(api).length, 0);
  });

  it('establishes a replacement admin before demoting an existing admin', async () => {
    await seed(api, model);
    model.users = [
      { email: 'admin@example.test', roles: ['author'] },
      { email: 'replacement@example.test', roles: ['admin'] },
    ];
    await syncConfig(api, model, { log });
    assert.deepEqual(writes(api).map((call) => call.body.email), [
      'replacement@example.test', 'admin@example.test',
    ]);
  });

  it('updates access only after all site and YAML changes succeed', async () => {
    await seed(api, model);
    api.store.get(`${prefix}/sites/demo.json`).access = { admin: { role: { admin: ['old'] } } };
    api.fail = `${prefix}/sites/demo/content/sitemap.yaml`;
    model.sites.demo.sitemap = {
      text: 'sitemaps: { revised: {} }\n',
      data: { sitemaps: { revised: {} } },
    };
    addExtras(api);
    await assert.rejects(syncConfig(api, model, { prune: true, log }), /Simulated/);
    assert.ok(!writes(api).some((call) => call.resource.endsWith('/access.json')));
    assert.ok(!writes(api).some((call) => call.method === 'DELETE'));
  });

  it('compares real substituted secrets without exposing values in output', async () => {
    // eslint-disable-next-line no-template-curly-in-string
    model.sites.demo.doc.cdn.prod.authToken = '${CDN_SECRET}';
    const prepared = prepareConfig(model, { CDN_SECRET: 'new-private-value' });
    await seed(api, prepared);
    api.store.get(`${prefix}/sites/demo.json`).cdn.prod.authToken = 'old-private-value';
    await syncConfig(api, prepared, { dryRun: true, log });
    assert.match(log.info.args.flat().join('\n'), /site demo: update/);
    assert.doesNotMatch(log.info.args.flat().join('\n'), /new-private-value|old-private-value/);
    await syncConfig(api, prepared, { log });
    assert.equal(api.store.get(`${prefix}/sites/demo.json`).cdn.prod.authToken, 'new-private-value');
  });

  it('rejects missing placeholders before network access', async () => {
    await fs.writeFile(
      path.join(root, 'site-config/sites/demo/cdn/prod.json'),
      // eslint-disable-next-line no-template-curly-in-string
      JSON.stringify({ authToken: '${AEM_CONFIG_TEST_MISSING_SECRET}' }),
    );
    await assert.rejects(new DeployCommand(log).withDirectory(root).run(), /Missing environment/);
    assert.equal(writes(api).length, 0);
  });

  it('requires the current key ID to remain in constrained site access', () => {
    model.sites.demo.doc.access.admin.apiKeyId = ['retained'];
    assert.throws(() => prepareConfig(model, {}), /AEM_CI_KEY_ID/);
    assert.throws(() => prepareConfig(model, { AEM_CI_KEY_ID: 'removed' }), /AEM_CI_KEY_ID/);
    assert.ok(prepareConfig(model, { AEM_CI_KEY_ID: 'retained' }));
  });

  it('reads selected-repo .dev.vars with real environment taking precedence', async () => {
    await fs.writeFile(path.join(root, '.dev.vars'), 'AEM_ADMIN_TOKEN=local\nCDN_SECRET=local\n');
    const env = await configEnvironment(root, { AEM_ADMIN_TOKEN: 'shell' });
    assert.equal(env.AEM_ADMIN_TOKEN, 'shell');
    assert.equal(env.CDN_SECRET, 'local');
    assert.equal((await configEnvironment(fixture, {})).AEM_ADMIN_TOKEN, undefined);
  });

  it('revalidates resolved host values before writes', () => {
    // eslint-disable-next-line no-template-curly-in-string
    model.sites.demo.doc.cdn.prod.host = '${CONFIG_TEST_HOST}';
    assert.throws(() => prepareConfig(model, {
      CONFIG_TEST_HOST: 'wrong.example.test',
    }), /origin does not match/);
  });

  it('fails on malformed JSON, YAML, unknown files and missing config', async () => {
    const site = path.join(root, 'site-config/sites/demo/site.json');
    await fs.writeFile(site, '{');
    await assert.rejects(loadConfig(root), /invalid JSON/);
    await fs.copyFile(path.join(fixture, 'site-config/sites/demo/site.json'), site);
    await fs.writeFile(path.join(root, 'site-config/sites/demo/unknown.json'), '{}');
    await assert.rejects(loadConfig(root), /unknown config file/);
    await fs.unlink(path.join(root, 'site-config/sites/demo/unknown.json'));
    await fs.writeFile(path.join(root, 'site-config/profiles/shared/content/query.yaml'), 'indices: [');
    await assert.rejects(loadConfig(root), /invalid YAML/);
    await fs.unlink(path.join(root, 'site-config/org/users.json'));
    await assert.rejects(loadConfig(root), /users.json/);
  });

  it('rejects empty users, duplicate users and removal of every organisation admin', async () => {
    const file = path.join(root, 'site-config/org/users.json');
    for (const users of [
      [], [model.users[0], model.users[0]], [model.users[1]],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(file, JSON.stringify(users));
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(loadConfig(root));
    }
  });

  it('rejects empty sites, unknown profiles, invalid roles and inline secrets', async () => {
    const file = path.join(root, 'site-config/sites/demo/site.json');
    for (const doc of [
      { ...model.sites.demo.doc, extends: { profile: 'missing' } },
      { ...model.sites.demo.doc, cdn: { prod: { authToken: 'inline-secret' } } },
      { ...model.sites.demo.doc, code: { owner: '../unsafe', repo: 'website' } },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(file, JSON.stringify(doc));
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(loadConfig(root));
    }
    await fs.rm(path.join(root, 'site-config/sites/demo'), { recursive: true });
    await assert.rejects(loadConfig(root), /no sites configured/);
  });

  it('rejects symlinked config files', async () => {
    const file = path.join(root, 'site-config/sites/demo/site.json');
    await fs.unlink(file);
    await fs.symlink(path.join(fixture, 'site-config/sites/demo/site.json'), file);
    await assert.rejects(loadConfig(root), /regular file/);
  });

  it('rejects non-object YAML definitions', () => {
    assert.throws(() => parseYaml('[]', 'query'), /object/);
  });

  it('rejects malformed managed-field and access shapes before writes', async () => {
    await fs.writeFile(path.join(root, 'site-config/sites/demo/headers.json'), '[]');
    await assert.rejects(loadConfig(root), /expected an object/);
    await fs.unlink(path.join(root, 'site-config/sites/demo/headers.json'));
    await fs.writeFile(
      path.join(root, 'site-config/sites/demo/access.json'),
      JSON.stringify({ admin: { role: { admin: [null] } } }),
    );
    await assert.rejects(loadConfig(root), /invalid admin role mapping/);
  });
});

describe('config command and Admin API', () => {
  let log;

  beforeEach(() => {
    log = logger();
  });

  afterEach(async () => {
    sinon.restore();
    await resetContext();
  });

  it('registers the sync subcommand and forwards all executor options', async () => {
    const registered = [];
    const builder = {
      command: (cmd) => {
        registered.push(cmd);
        return builder;
      },
      demandCommand: () => builder,
      help: () => builder,
    };
    config().builder(builder);
    assert.equal(registered[0].command, 'deploy');
    const executor = {};
    for (const name of ['withDirectory', 'withDryRun', 'withPrune']) {
      executor[name] = sinon.stub().returns(executor);
    }
    executor.run = sinon.stub().resolves();
    const cmd = deploy();
    cmd.executor = executor;
    await cmd.handler({ dryRun: true, prune: true });
    sinon.assert.calledWithExactly(executor.withDirectory, process.cwd());
    sinon.assert.calledWithExactly(executor.withDryRun, true);
    sinon.assert.calledWithExactly(executor.withPrune, true);
    sinon.assert.calledOnce(executor.run);
  });

  it('shows help without requiring configuration or authentication', async () => {
    const { stdout } = await run(process.execPath, [cli, 'config', 'deploy', '--help']);
    assert.match(stdout, /--prune/);
    assert.match(stdout, /--dry-run/);
    assert.doesNotMatch(stdout, /--root/);
    const main = await run(process.execPath, [cli, '--help']);
    assert.match(main.stdout, /aem config/);
  });

  it('rejects unknown arguments and a missing config subcommand', async () => {
    await assert.rejects(
      run(process.execPath, [cli, 'config', 'deploy', '--root', fixture]),
      (error) => /Unknown argument.*root/.test(error.stderr),
    );
    await assert.rejects(
      run(process.execPath, [cli, 'config', 'deploy', '--unknown']),
      (error) => /Unknown argument/.test(error.stderr),
    );
    await assert.rejects(
      run(process.execPath, [cli, 'config']),
      (error) => /config subcommand/.test(error.stderr),
    );
  });

  it('requires a token and rejects credential-bearing or non-HTTP endpoints', () => {
    assert.throws(() => new AdminApi({ log }), /AEM_ADMIN_TOKEN/);
    const options = { token: 'private', log };
    for (const base of ['file:///tmp', 'https://user:password@example.test',
      'https://example.test/config', 'https://example.test/?token=value']) {
      assert.throws(() => new AdminApi({ ...options, base }), /AEM_ADMIN_BASE.*origin/);
    }
  });

  it('authenticates and serializes JSON and YAML without following redirects', async () => {
    const api = new AdminApi({ token: 'private', log });
    api.fetch = sinon.stub().callsFake(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await api.request('POST', '/config/example/users.json', { body: { roles: ['admin'] } });
    assert.equal(api.fetch.firstCall.args[1].headers.authorization, 'token private');
    assert.equal(api.fetch.firstCall.args[1].headers['content-type'], 'application/json');
    assert.equal(api.fetch.firstCall.args[1].redirect, 'error');
    await api.request('PUT', '/config/example/sites/demo/content/query.yaml', {
      body: 'indices: {}', type: 'text/yaml',
    });
    assert.equal(api.fetch.secondCall.args[1].body, 'indices: {}');
    assert.equal(api.fetch.secondCall.args[1].headers['content-type'], 'text/yaml');
  });

  it('only treats individual-resource 404s as missing; surfaces auth and server failures', async () => {
    const api = new AdminApi({ token: 'private', log });
    api.fetch = sinon.stub();
    for (const status of [401, 403, 404, 500]) {
      api.fetch.resolves(new Response('private-secret', { status }));
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(api.get('/config/example/users.json'), (error) => (
        error.message.includes(String(status)) && !error.message.includes('private-secret')
      ));
    }
    api.fetch.resolves(new Response('', { status: 404 }));
    assert.equal((await api.get('/config/example/sites/demo.json', true)).status, 404);
    api.fetch.resolves(new Response('{', {
      headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(api.get('/config/example/users.json'), /invalid JSON response/);
  });

  it('retries throttling with a bounded attempt count', async () => {
    const clock = sinon.useFakeTimers();
    const api = new AdminApi({ token: 'private', log });
    api.fetch = sinon.stub().resolves({
      status: 429,
      text: async () => '',
      headers: { get: () => null },
    });
    const result = assert.rejects(api.get('/config/example/users.json'), /429/);
    await clock.runAllAsync();
    await result;
    sinon.assert.callCount(api.fetch, 4);
    sinon.assert.callCount(log.warn, 3);
  });

  it('runs the CLI end-to-end against a local Admin API without default deletion', async () => {
    const memory = new MemoryApi();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-config-cli-test-'));
    await fs.cp(fixture, root, { recursive: true });
    await initRepository(root);
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, 'token test-only-token');
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString();
        const body = req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
        const response = req.method === 'GET'
          ? await memory.get(req.url, true)
          : await memory.request(req.method, req.url, { body });
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
    const env = {
      ...process.env,
      AEM_ADMIN_TOKEN: 'test-only-token',
      AEM_ADMIN_BASE: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1',
    };
    try {
      await run(process.execPath, [cli, 'config', 'deploy'], { env, cwd: root });
      assert.equal(writes(memory).length, 6);
      assert.ok(writes(memory).every((call) => call.method !== 'DELETE'));
      memory.calls.length = 0;
      await run(process.execPath, [cli, 'config', 'deploy', '--dry-run'], { env, cwd: root });
      assert.equal(writes(memory).length, 0);
      addExtras(memory);
      await run(process.execPath, [
        cli, 'config', 'deploy', '--dry-run', '--prune',
      ], { env, cwd: root });
      assert.equal(writes(memory).length, 0);
      await run(process.execPath, [cli, 'config', 'deploy', '--prune'], { env, cwd: root });
      assert.equal(writes(memory).filter((call) => call.method === 'DELETE').length, 3);
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  }).timeout(10000);
});
