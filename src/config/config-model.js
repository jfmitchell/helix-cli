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
import YAML from 'yaml';
import dotenv from 'dotenv';
import GitUtils from '../git-utils.js';

export const PROFILE_KEYS = ['description', 'title', 'headers', 'metadata', 'sidekick', 'public'];
export const SITE_KEYS = [
  ...PROFILE_KEYS, 'code', 'content', 'cdn', 'access', 'robots', 'folders', 'extends',
];
export const ROLES = new Set([
  'admin', 'author', 'publish', 'develop', 'basic_author', 'basic_publish', 'config', 'config_admin',
]);
export const SECRET = /^(auth[-_]?token|token|secret|password|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|authorization|proxy[-_]authorization|credentials|cookie|set[-_]cookie|x[-_]api[-_]key|private[-_]?key)$/i;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SITE_FILES = [
  'site.json', 'access.json', 'headers.json', 'cdn/prod.json', 'robots.txt',
  'content/sitemap.yaml', 'content/query.yaml',
];
const PROFILE_FILES = ['profile.json', 'content/query.yaml'];

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!object(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value;
}

export function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${label}: invalid identifier`);
  }
  return value;
}

export async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
}

export function parseYaml(text, label) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    throw new Error(`${label}: invalid YAML`);
  }
  return requireObject(doc.toJS(), label);
}

async function readYaml(file) {
  const text = await fs.readFile(file, 'utf8');
  return { text, data: parseYaml(text, file) };
}

async function filesIn(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...await filesIn(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`${path.join(dir, entry.name)}: expected a regular file or directory`);
    }
  }
  return files;
}

async function resources(dir, allowed, required, load, allowMissing = false) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing || error.path !== dir) {
      throw error;
    }
    return {};
  }
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    identifier(entry.name, dir);
    if (!entry.isDirectory()) {
      throw new Error(`${dir}/${entry.name}: expected a directory`);
    }
    const resourceDir = path.join(dir, entry.name);
    // eslint-disable-next-line no-await-in-loop
    const files = await filesIn(resourceDir);
    if (!files.includes(required)) {
      throw new Error(`${resourceDir}: missing ${required}`);
    }
    for (const file of files) {
      if (!allowed.includes(file)) {
        throw new Error(`${resourceDir}/${file}: unknown config file`);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    result[entry.name] = await load(resourceDir, files);
  }
  return result;
}

function validateRoles(roles, label) {
  if (!Array.isArray(roles) || !roles.length || roles.some((role) => !ROLES.has(role))) {
    throw new Error(`${label}: expected a nonempty array of valid roles`);
  }
}

function validateSecrets(value, label) {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET.test(key) && typeof child === 'string' && !/^\$\{[A-Z0-9_]+\}$/.test(child)) {
      throw new Error(`${label}.${key}: use an environment placeholder for secrets`);
    }
    validateSecrets(child, `${label}.${key}`);
  }
}

export function substitute(value, env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
      if (env[name] === undefined) {
        throw new Error(`Missing environment variable: ${name}`);
      }
      return env[name];
    });
  }
  if (Array.isArray(value)) {
    return value.map((child) => substitute(child, env));
  }
  if (object(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, substitute(child, env)]));
  }
  return value;
}

function validateDocument(doc, label) {
  for (const key of ['description', 'title']) {
    if (doc[key] !== undefined && typeof doc[key] !== 'string') {
      throw new Error(`${label}.${key}: expected a string`);
    }
  }
  for (const key of ['headers', 'metadata', 'sidekick', 'folders', 'cdn', 'robots']) {
    if (doc[key] !== undefined) {
      requireObject(doc[key], `${label}.${key}`);
    }
  }
  if (doc.cdn?.prod !== undefined) {
    requireObject(doc.cdn.prod, `${label}.cdn.prod`);
  }
  if (doc.robots !== undefined && typeof doc.robots.txt !== 'string') {
    throw new Error(`${label}.robots.txt: expected a string`);
  }
}

export function validateModel(model, checkSecrets = true, complete = true) {
  const {
    org, users, profiles, sites,
  } = model;
  identifier(org, 'Git origin owner');
  if (!Array.isArray(users) || (complete && !users.length)) {
    throw new Error('site-config/org/users.json: expected a nonempty array of users');
  }
  const emails = new Set();
  for (const user of users) {
    requireObject(user, 'org user');
    if (typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email)) {
      throw new Error('org user: invalid email');
    }
    const email = user.email.toLowerCase();
    if (emails.has(email)) {
      throw new Error('org users: duplicate email');
    }
    emails.add(email);
    validateRoles(user.roles, 'org user roles');
  }
  if (complete && !users.some((user) => user.roles.includes('admin'))) {
    throw new Error('org users: at least one admin must remain');
  }
  if (complete && !Object.keys(sites).length) {
    throw new Error('site-config/sites: no sites configured');
  }
  for (const [name, profile] of Object.entries(profiles)) {
    validateDocument(profile.doc, `profile ${name}`);
    for (const key of Object.keys(profile.doc)) {
      if (!PROFILE_KEYS.includes(key)) {
        throw new Error(`profile ${name}: unsupported key ${key}`);
      }
    }
    if (checkSecrets) {
      validateSecrets(profile.doc, `profile ${name}`);
    }
  }
  const hosts = new Set();
  for (const [name, site] of Object.entries(sites)) {
    const { doc } = site;
    validateDocument(doc, `site ${name}`);
    for (const key of Object.keys(doc)) {
      if (!SITE_KEYS.includes(key)) {
        throw new Error(`site ${name}: unsupported key ${key}`);
      }
    }
    if (doc.extends !== undefined) {
      requireObject(doc.extends, `site ${name} extends`);
      identifier(doc.extends.profile, `site ${name} profile`);
      if (!Object.hasOwn(profiles, doc.extends.profile)) {
        throw new Error(`site ${name}: unknown profile`);
      }
    }
    requireObject(doc.code, `site ${name} code`);
    identifier(doc.code.owner, `site ${name} code owner`);
    identifier(doc.code.repo, `site ${name} code repo`);
    const source = requireObject(doc.content?.source, `site ${name} content.source`);
    if (typeof source.type !== 'string' || !source.type.trim()) {
      throw new Error(`site ${name}: content.source.type is required`);
    }
    if (source.type !== 'sourcebus' && (typeof source.url !== 'string' || !source.url)) {
      throw new Error(`site ${name}: content.source.url is required`);
    }
    if (doc.access !== undefined) {
      requireObject(doc.access, `site ${name} access`);
      if (doc.access.admin !== undefined) {
        requireObject(doc.access.admin, `site ${name} access.admin`);
      }
      const roles = doc.access.admin?.role;
      if (roles !== undefined) {
        requireObject(roles, `site ${name} admin roles`);
        if (!Array.isArray(roles.admin) || !roles.admin.length) {
          throw new Error(`site ${name}: access removes every admin`);
        }
        for (const [role, members] of Object.entries(roles)) {
          if (!ROLES.has(role) || !Array.isArray(members)
            || members.some((member) => typeof member !== 'string' || !member.trim())) {
            throw new Error(`site ${name}: invalid admin role mapping`);
          }
        }
      }
      const ids = doc.access.admin?.apiKeyId;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
        throw new Error(`site ${name}: invalid access.admin.apiKeyId`);
      }
    }
    if (/^Disallow:\s*\/\s*$/m.test(doc.robots?.txt || '')) {
      throw new Error(`site ${name}: robots disallows everything`);
    }
    const host = doc.cdn?.prod?.host;
    if (host) {
      if (typeof host !== 'string' || hosts.has(host)) {
        throw new Error(`site ${name}: invalid or duplicate host`);
      }
      hosts.add(host);
      for (const sitemap of Object.values(site.sitemap?.data.sitemaps || {})) {
        if (sitemap.origin && !/\$\{[A-Z0-9_]+\}/.test(`${sitemap.origin}${host}`)
          && new URL(sitemap.origin).host !== host) {
          throw new Error(`site ${name}: sitemap origin does not match host`);
        }
      }
    }
    if (checkSecrets) {
      validateSecrets(doc, `site ${name}`);
    }
  }
}

export async function configIdentity(root) {
  let origin;
  try {
    origin = await GitUtils.getOriginURL(root);
  } catch {
    throw new Error('Cannot determine organisation: invalid Git origin remote');
  }
  if (!origin) {
    throw new Error('Cannot determine organisation: configure a Git origin remote in this repository');
  }
  if (!origin.host || !['https', 'http', 'ssh', 'git'].includes(origin.protocol)) {
    throw new Error('Cannot determine organisation: Git origin must be a remote repository URL');
  }
  const org = identifier(origin.owner, 'Git origin owner').toLowerCase();
  identifier(origin.repo, 'Git origin repository');
  return { org, owner: origin.owner, repo: origin.repo };
}

export async function loadConfig(root, { allowIncomplete = false } = {}) {
  const { org } = await configIdentity(root);
  const configDir = path.join(root, 'site-config');
  let orgFiles;
  try {
    orgFiles = await filesIn(path.join(configDir, 'org'));
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowIncomplete || error.path !== path.join(configDir, 'org')) {
      throw error;
    }
    orgFiles = [];
  }
  if (orgFiles.some((file) => file !== 'users.json')
    || (!allowIncomplete && !orgFiles.includes('users.json'))) {
    throw new Error('site-config/org: expected only users.json');
  }
  const users = orgFiles.includes('users.json')
    ? await readJson(path.join(configDir, 'org', 'users.json')) : [];
  const profiles = await resources(
    path.join(configDir, 'profiles'),
    PROFILE_FILES,
    'profile.json',
    async (dir, files) => ({
      doc: requireObject(await readJson(path.join(dir, 'profile.json')), dir),
      query: files.includes('content/query.yaml') ? await readYaml(path.join(dir, 'content/query.yaml')) : null,
    }),
    allowIncomplete,
  );
  const sites = await resources(path.join(configDir, 'sites'), SITE_FILES, 'site.json', async (dir, files) => {
    const doc = requireObject(await readJson(path.join(dir, 'site.json')), dir);
    validateSecrets(doc, dir);
    for (const [file, key] of [['access.json', 'access'], ['headers.json', 'headers']]) {
      if (files.includes(file)) {
        // eslint-disable-next-line no-await-in-loop
        doc[key] = requireObject(await readJson(path.join(dir, file)), `${dir}/${file}`);
      }
    }
    if (files.includes('cdn/prod.json')) {
      doc.cdn = { ...doc.cdn, prod: requireObject(await readJson(path.join(dir, 'cdn/prod.json')), dir) };
    }
    if (files.includes('robots.txt')) {
      doc.robots = { txt: await fs.readFile(path.join(dir, 'robots.txt'), 'utf8') };
    }
    return {
      doc,
      sitemap: files.includes('content/sitemap.yaml') ? await readYaml(path.join(dir, 'content/sitemap.yaml')) : null,
      query: files.includes('content/query.yaml') ? await readYaml(path.join(dir, 'content/query.yaml')) : null,
    };
  }, allowIncomplete);
  const model = {
    org, users, profiles, sites,
  };
  validateModel(model, true, !allowIncomplete);
  return model;
}

export async function configEnvironment(root, env = process.env) {
  let local = {};
  try {
    local = dotenv.parse(await fs.readFile(path.join(root, '.dev.vars'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return { ...local, ...env };
}

export function prepareConfig(model, env) {
  const prepared = substitute(model, env);
  validateModel(prepared, false);
  for (const [name, site] of Object.entries(prepared.sites)) {
    const ids = site.doc.access?.admin?.apiKeyId;
    if (ids?.length && (!env.AEM_CI_KEY_ID || !ids.includes(env.AEM_CI_KEY_ID))) {
      throw new Error(`site ${name}: AEM_CI_KEY_ID must remain in access.admin.apiKeyId`);
    }
    for (const resource of [
      site.sitemap, site.query, prepared.profiles[site.doc.extends?.profile]?.query,
    ]) {
      if (resource) {
        resource.data = parseYaml(resource.text, `site ${name} content config`);
      }
    }
  }
  return prepared;
}
