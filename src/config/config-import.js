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
import YAML from 'yaml';
import {
  PROFILE_KEYS, SITE_KEYS, SECRET, object, parseYaml, validateModel,
} from './config-model.js';
import {
  document, resourceNames, same, validateUsers,
} from './config-sync.js';
import { json } from './config-files.js';

const pick = (value, keys) => Object.fromEntries(
  keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
);

export function sanitizer() {
  const variables = new Set();
  const names = new Map();
  const reserve = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
        names.set(match[1], 'reserved');
      }
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(reserve);
    }
  };
  const placeholder = (value, location) => {
    if (typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value)) {
      variables.add(value.slice(2, -1));
      return value;
    }
    const base = `AEM_CONFIG_${location.join('_').replace(/[^A-Z0-9_]/gi, '_').toUpperCase()}`;
    let name = base;
    let suffix = 1;
    const key = JSON.stringify(location);
    while (names.has(name) && names.get(name) !== key) {
      suffix += 1;
      name = `${base}_${suffix}`;
    }
    names.set(name, key);
    variables.add(name);
    return `\${${name}}`;
  };
  const sanitize = (value, location, sensitive = false) => {
    if (typeof value === 'string') {
      let url;
      try {
        url = new URL(value);
      } catch {
        // Most configuration strings are not URLs.
      }
      const secretUrl = url && (url.username || url.password
        || [...url.searchParams.keys()].some((key) => SECRET.test(key)));
      if (sensitive || secretUrl) {
        return placeholder(value, location);
      }
      for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
        variables.add(match[1]);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => sanitize(entry, [...location, index], sensitive));
    }
    if (object(value)) {
      const sensitiveHeader = SECRET.test(value.key || '') || SECRET.test(value.name || '');
      return Object.fromEntries(Object.keys(value).sort().map((key) => [
        key,
        sanitize(
          value[key],
          [...location, key],
          sensitive || SECRET.test(key) || (sensitiveHeader && key === 'value'),
        ),
      ]));
    }
    if (sensitive && value !== null && value !== undefined) {
      throw new Error(`${location.join('.')}: secret values must be strings for environment placeholders`);
    }
    return value;
  };
  return { sanitize, reserve, variables };
}

async function readYaml(api, resource) {
  const response = await api.get(resource, true);
  if (response.status === 404) {
    return null;
  }
  if (typeof response.data !== 'string') {
    throw new Error(`${resource}: expected YAML`);
  }
  return parseYaml(response.data, resource);
}

function userSnapshot(users) {
  return users.map((user) => ({
    email: user.email, roles: [...user.roles].sort(),
  })).sort((a, b) => a.email.localeCompare(b.email));
}

export async function importSnapshot(api, org) {
  const prefix = `/config/${org}`;
  const users = validateUsers((await api.get(`${prefix}/users.json`)).data, false);
  const siteNames = (await resourceNames(api, prefix, 'sites')).sort();
  const profileNames = (await resourceNames(api, prefix, 'profiles')).sort();
  const { sanitize, reserve, variables } = sanitizer();
  const model = {
    org, users: userSnapshot(users), profiles: {}, sites: {},
  };
  for (const name of profileNames) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await document(api, `${prefix}/profiles/${name}.json`, false);
    model.profiles[name] = {
      doc: pick(raw, PROFILE_KEYS), query: null,
    };
  }
  for (const name of siteNames) {
    // The config document endpoint is raw; aggregated config is a separate API.
    // eslint-disable-next-line no-await-in-loop
    const raw = await document(api, `${prefix}/sites/${name}.json`, false);
    const doc = structuredClone(pick(raw, SITE_KEYS));
    if (doc.content) {
      delete doc.content.contentBusId;
    }
    // eslint-disable-next-line no-await-in-loop
    const query = await readYaml(
      api,
      `${prefix}/sites/${name}/content/query.yaml`,
    );
    // eslint-disable-next-line no-await-in-loop
    const sitemap = await readYaml(
      api,
      `${prefix}/sites/${name}/content/sitemap.yaml`,
    );
    model.sites[name] = { doc, query, sitemap };
  }
  const latestSites = (await resourceNames(api, prefix, 'sites')).sort();
  const latestProfiles = (await resourceNames(api, prefix, 'profiles')).sort();
  const latestUsers = validateUsers((await api.get(`${prefix}/users.json`)).data, false);
  if (!same(siteNames, latestSites) || !same(profileNames, latestProfiles)
    || !same(userSnapshot(users), userSnapshot(latestUsers))) {
    throw new Error('Organisation inventory changed during import; retry the command');
  }
  reserve(model);
  for (const [name, profile] of Object.entries(model.profiles)) {
    profile.doc = sanitize(profile.doc, ['PROFILE', name]);
  }
  for (const [name, site] of Object.entries(model.sites)) {
    site.doc = sanitize(site.doc, ['SITE', name]);
    for (const key of ['query', 'sitemap']) {
      if (site[key]) {
        const data = sanitize(site[key], ['SITE', name, key.toUpperCase()]);
        site[key] = { data, text: YAML.stringify(data) };
      }
    }
  }
  validateModel(model);
  const files = new Map();
  const directories = new Set(['org', 'profiles', 'sites']);
  const put = (name, content) => files.set(name, { content });
  put('org/users.json', json(model.users));
  for (const [name, profile] of Object.entries(model.profiles)) {
    directories.add(`profiles/${name}`);
    put(`profiles/${name}/profile.json`, json(profile.doc));
  }
  for (const [name, site] of Object.entries(model.sites)) {
    const dir = `sites/${name}`;
    directories.add(dir);
    const doc = structuredClone(site.doc);
    for (const key of ['access', 'headers']) {
      if (doc[key] !== undefined) {
        put(`${dir}/${key}.json`, json(doc[key]));
        delete doc[key];
      }
    }
    if (doc.cdn?.prod !== undefined) {
      put(`${dir}/cdn/prod.json`, json(doc.cdn.prod));
      delete doc.cdn.prod;
      if (!Object.keys(doc.cdn).length) {
        delete doc.cdn;
      }
    }
    if (doc.robots && Object.keys(doc.robots).length === 1) {
      put(`${dir}/robots.txt`, doc.robots.txt);
      delete doc.robots;
    }
    put(`${dir}/site.json`, json(doc));
    if (site.query) {
      put(`${dir}/content/query.yaml`, site.query.text);
    }
    if (site.sitemap) {
      put(`${dir}/content/sitemap.yaml`, site.sitemap.text);
    }
  }
  return {
    model, files, directories, variables: [...variables].sort(),
  };
}
