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
import {
  SITE_KEYS, PROFILE_KEYS, object, identifier, parseYaml,
} from './config-model.js';

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (object(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function same(before, after) {
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

function mergeManaged(live, desired, keys) {
  const merged = { ...live };
  for (const key of keys) {
    if (desired[key] === undefined) {
      delete merged[key];
    } else {
      merged[key] = desired[key];
    }
  }
  return merged;
}

export async function document(api, resource, allowMissing = true) {
  const response = await api.get(resource, allowMissing);
  if (response.status === 404) {
    if (!allowMissing) {
      throw new Error(`${resource}: listed configuration disappeared during import`);
    }
    return null;
  }
  if (!object(response.data)) {
    throw new Error(`${resource}: expected a configuration object`);
  }
  return response.data;
}

export function completeInventory(data, key) {
  const entries = Array.isArray(data) ? data : data?.[key];
  if (!Array.isArray(entries) || data?.next || data?.cursor || data?.links?.next
    || data?.hasMore || data?.truncated
    || (data?.total !== undefined && data.total !== entries.length)) {
    throw new Error(`Admin API ${key}: expected a complete inventory`);
  }
  return entries;
}

export async function resourceNames(api, prefix, key) {
  const { data } = await api.get(`${prefix}/${key}.json`);
  const names = completeInventory(data, key).map((entry) => identifier(typeof entry === 'string' ? entry : entry?.name, `Admin API ${key}`));
  if (new Set(names).size !== names.length) {
    throw new Error(`Admin API ${key}: duplicate resource names`);
  }
  return names;
}

export function validateUsers(data, prune) {
  const users = completeInventory(data, 'users');
  const emails = new Set();
  const ids = new Set();
  for (const user of users) {
    if (!object(user) || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email)
      || !Array.isArray(user.roles) || user.roles.some((role) => typeof role !== 'string')) {
      throw new Error('Admin API users: invalid user');
    }
    const email = user.email.toLowerCase();
    if (emails.has(email)) {
      throw new Error('Admin API users: duplicate email');
    }
    emails.add(email);
    if (prune) {
      identifier(user.id, 'Admin API user ID');
      if (ids.has(user.id)) {
        throw new Error('Admin API users: duplicate user ID');
      }
      ids.add(user.id);
    }
  }
  return users;
}

async function yamlChange(api, resource, desired, exists, changes, label) {
  if (!desired) {
    return;
  }
  const current = exists ? await api.get(resource, true) : { status: 404 };
  if (current.status !== 404
    && (typeof current.data !== 'string' || !current.data.trim())) {
    throw new Error(`${resource}: expected YAML configuration`);
  }
  if (current.status === 404 || !same(parseYaml(current.data, resource), desired.data)) {
    changes.push({
      method: current.status === 404 ? 'PUT' : 'POST',
      resource,
      body: desired.text,
      type: 'text/yaml',
      label,
    });
  }
}

/**
 * Build the entire reconciliation before any writes. Pruning never runs on an
 * incomplete inventory or after a failed create/update.
 */
export async function planSync(api, model, { prune = false } = {}) {
  const prefix = `/config/${model.org}`;
  const changes = [];
  const accessChanges = [];
  const liveUsers = validateUsers((await api.get(`${prefix}/users.json`)).data, prune);
  let liveSites = [];
  let liveProfiles = [];
  if (prune) {
    liveSites = await resourceNames(api, prefix, 'sites');
    liveProfiles = await resourceNames(api, prefix, 'profiles');
  }

  // Establish desired admins before demoting existing users.
  const orderedUsers = [...model.users].sort((a, b) => (
    Number(b.roles.includes('admin')) - Number(a.roles.includes('admin'))
  ));
  for (const user of orderedUsers) {
    const current = liveUsers.find((live) => live.email.toLowerCase() === user.email.toLowerCase());
    if (!current || !same([...current.roles].sort(), [...user.roles].sort())) {
      changes.push({
        method: 'POST',
        resource: `${prefix}/users.json`,
        body: { email: current?.email || user.email, roles: user.roles },
        label: `user ${user.email}: ${current ? 'update' : 'create'}`,
      });
    }
  }
  for (const [name, profile] of Object.entries(model.profiles)) {
    const resource = `${prefix}/profiles/${name}.json`;
    // eslint-disable-next-line no-await-in-loop
    const live = await document(api, resource);
    const desired = mergeManaged(live, profile.doc, PROFILE_KEYS);
    if (!live || !same(live, desired)) {
      changes.push({
        method: live ? 'POST' : 'PUT',
        resource,
        body: desired,
        label: `profile ${name}: ${live ? 'update' : 'create'}`,
      });
    }
  }
  for (const [name, site] of Object.entries(model.sites)) {
    const resource = `${prefix}/sites/${name}.json`;
    // eslint-disable-next-line no-await-in-loop
    const live = await document(api, resource);
    const doc = structuredClone(site.doc);
    if (doc.content && doc.content.contentBusId === undefined
      && live?.content?.contentBusId !== undefined) {
      doc.content.contentBusId = live.content.contentBusId;
    }
    const desired = mergeManaged(live, doc, SITE_KEYS.filter((key) => key !== 'access'));
    if (!live) {
      if (doc.access !== undefined) {
        desired.access = doc.access;
      }
    }
    if (!live || !same(live, desired)) {
      changes.push({
        method: live ? 'POST' : 'PUT',
        resource,
        body: desired,
        label: `site ${name}: ${live ? 'update' : 'create'}`,
      });
    }
    const profile = model.profiles[doc.extends?.profile];
    // eslint-disable-next-line no-await-in-loop
    await yamlChange(
      api,
      `${prefix}/sites/${name}/content/query.yaml`,
      site.query || profile?.query,
      !!live,
      changes,
      `site ${name}: update query definitions`,
    );
    // eslint-disable-next-line no-await-in-loop
    await yamlChange(
      api,
      `${prefix}/sites/${name}/content/sitemap.yaml`,
      site.sitemap,
      !!live,
      changes,
      `site ${name}: update sitemap definitions`,
    );
    if (live && !same(live.access || {}, doc.access || {})) {
      accessChanges.push({
        method: 'POST',
        resource: `${prefix}/sites/${name}/access.json`,
        body: doc.access || {},
        label: `site ${name}: update access`,
      });
    }
  }
  changes.push(...accessChanges);

  if (prune) {
    for (const [key, names, desired] of [
      ['sites', liveSites, model.sites], ['profiles', liveProfiles, model.profiles],
    ]) {
      for (const name of names.filter((live) => !Object.hasOwn(desired, live))) {
        changes.push({
          method: 'DELETE',
          resource: `${prefix}/${key}/${name}.json`,
          label: `${key.slice(0, -1)} ${name}: delete (--prune)`,
        });
      }
    }
    for (const user of liveUsers) {
      const retained = model.users.some((desired) => (
        desired.email.toLowerCase() === user.email.toLowerCase()
      ));
      if (!retained) {
        changes.push({
          method: 'DELETE',
          resource: `${prefix}/users/${user.id}.json`,
          label: `user ${user.email}: delete (--prune)`,
        });
      }
    }
  }
  return changes;
}

export async function syncConfig(api, model, { prune = false, dryRun = false, log }) {
  log.info(`Configuration deployment: ${model.org}${dryRun ? ' (dry run)' : ''}`);
  if (prune) {
    log.warn('--prune removes users, sites and profiles absent from this repository.');
  }
  const changes = await planSync(api, model, { prune });
  if (!changes.length) {
    log.info('No config changes.');
    return;
  }
  for (const change of changes) {
    log.info(`${dryRun ? '[dry-run] ' : ''}${change.label}`);
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await api.request(change.method, change.resource, {
        body: change.body, type: change.type,
      });
    }
  }
  log.info(`${dryRun ? 'Planned' : 'Applied'} ${changes.length} config change(s).`);
}
