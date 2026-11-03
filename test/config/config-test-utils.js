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
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sinon from 'sinon';
import { syncConfig } from '../../src/config/config-sync.js';

export const run = promisify(execFile);
export const fixture = path.resolve('test/fixtures/config');
export const cli = path.resolve('index.js');
export const prefix = '/config/example';

export class MemoryApi {
  constructor() {
    this.store = new Map();
    this.users = [];
    this.calls = [];
    this.fail = null;
    this.inventories = {};
  }

  async get(resource, allowMissing = false) {
    this.calls.push({ method: 'GET', resource });
    if (this.fail === `GET ${resource}`) {
      throw new Error('Simulated read failure');
    }
    if (Object.hasOwn(this.inventories, resource)) {
      const data = this.inventories[resource];
      return { status: 200, data: typeof data === 'function' ? data() : data };
    }
    if (resource === `${prefix}/users.json`) {
      return { status: 200, data: structuredClone(this.users) };
    }
    for (const key of ['sites', 'profiles']) {
      if (resource === `${prefix}/${key}.json`) {
        const pattern = new RegExp(`^${prefix}/${key}/([^/]+)\\.json$`);
        const names = [...this.store.keys()]
          .map((entry) => entry.match(pattern)?.[1]).filter(Boolean);
        return { status: 200, data: { [key]: names.map((name) => ({ name })) } };
      }
    }
    if (!this.store.has(resource) && !allowMissing) {
      throw new Error(`Missing resource: ${resource}`);
    }
    return this.store.has(resource)
      ? { status: 200, data: structuredClone(this.store.get(resource)) }
      : { status: 404, data: null };
  }

  async request(method, resource, { body, type } = {}) {
    this.calls.push({
      method, resource, body: structuredClone(body), type,
    });
    if (this.fail === resource) {
      throw new Error('Simulated write failure');
    }
    if (resource === `${prefix}/users.json`) {
      const user = this.users.find((current) => current.email === body.email);
      if (user) {
        Object.assign(user, body);
      } else {
        this.users.push({ id: `u${this.users.length + 1}`, ...body });
      }
    } else if (method === 'DELETE') {
      if (resource.startsWith(`${prefix}/users/`)) {
        this.users = this.users.filter((user) => resource !== `${prefix}/users/${user.id}.json`);
      } else {
        this.store.delete(resource);
      }
    } else if (resource.endsWith('/access.json')) {
      this.store.get(resource.replace('/access.json', '.json')).access = structuredClone(body);
    } else {
      this.store.set(resource, structuredClone(body));
    }
    return { status: 200, data: {} };
  }
}

export function logger() {
  return { info: sinon.spy(), warn: sinon.spy() };
}

export async function seed(api, model) {
  await syncConfig(api, model, { log: logger() });
  api.calls.splice(0);
}

export function writes(api) {
  return api.calls.filter((call) => call.method !== 'GET');
}

export function addExtras(api) {
  api.store.set(`${prefix}/sites/extra.json`, {});
  api.store.set(`${prefix}/profiles/extra.json`, {});
  api.users.push({ id: 'extra', email: 'extra@example.test', roles: ['admin'] });
}

export async function initRepository(dir, origin = 'https://github.com/Example/website.git') {
  await run('git', ['init', '--quiet'], { cwd: dir });
  await run('git', ['remote', 'add', 'origin', origin], { cwd: dir });
}
