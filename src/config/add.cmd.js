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
import { AbstractCommand } from '../abstract.cmd.js';
import {
  configIdentity, identifier, loadConfig, ROLES, validateModel,
} from './config-model.js';
import ConfigPrompts from './config-prompts.js';
import { readTree, installTree, json } from './config-files.js';

function email(value) {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new Error('A valid user email is required');
  }
  return value;
}

function roles(value) {
  const result = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).trim().split(/[,\s]+/));
  if (!result.length || result.some((role) => !ROLES.has(role))) {
    throw new Error(`Roles must be selected from: ${[...ROLES].join(', ')}`);
  }
  return [...new Set(result)];
}

function sourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('An external content source requires a valid --source-url');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Content source URL must be HTTP(S) without embedded credentials');
  }
  return value;
}

export default class AddCommand extends AbstractCommand {
  constructor(log, kind) {
    super(log);
    this.kind = kind;
    this.prompts = new ConfigPrompts(this.log);
  }

  withOptions(options) {
    this.options = options;
    return this;
  }

  async run() {
    const previous = await readTree(this.directory);
    const identity = await configIdentity(this.directory);
    const model = await loadConfig(this.directory, { allowIncomplete: true });
    const options = this.options || {};
    const type = options.sourceType ?? 'sourcebus';
    if (this.kind === 'site' && !['sourcebus', 'markup', 'google', 'onedrive'].includes(type)) {
      throw new Error('Unknown content --source-type');
    }
    const missing = [];
    const positional = this.kind === 'user' ? 'email' : 'name';
    if (options[positional] === undefined) {
      missing.push(`[${positional}]`);
    }
    if (this.kind === 'user' && options.roles === undefined) {
      missing.push('--roles');
    }
    if (this.kind === 'site' && type !== 'sourcebus'
      && options.sourceUrl === undefined) {
      missing.push('--source-url');
    }
    this.prompts.requireInputs(missing);
    const files = new Map(previous.files);
    const directories = new Set([...previous.directories, 'org', 'profiles', 'sites']);
    let name;
    if (this.kind === 'user') {
      name = options.email === undefined
        ? await this.prompts.ask('User email', email) : email(options.email);
      const userRoles = options.roles === undefined
        ? await this.prompts.ask(`Roles (${[...ROLES].join(', ')})`, roles) : roles(options.roles);
      if (model.users.some((user) => user.email.toLowerCase() === name.toLowerCase())) {
        throw new Error('User already exists; add never updates existing users');
      }
      model.users.push({ email: name, roles: userRoles });
      files.set('org/users.json', {
        content: json(model.users), mode: previous.files.get('org/users.json')?.mode,
      });
    } else {
      name = options.name === undefined
        ? await this.prompts.ask(`${this.kind} name`, (value) => identifier(value, 'name'))
        : identifier(options.name, 'name');
      const kind = `${this.kind}s`;
      const dir = `${kind}/${name}`;
      if (previous.directories.has(dir) || Object.hasOwn(model[kind], name)) {
        throw new Error(`${this.kind} ${name} already exists; add never overwrites`);
      }
      const doc = { title: options.title === undefined ? name : options.title };
      if (this.kind === 'site') {
        const source = { type };
        if (type !== 'sourcebus') {
          source.url = options.sourceUrl === undefined
            ? await this.prompts.ask('Content --source-url', sourceUrl) : sourceUrl(options.sourceUrl);
        } else if (options.sourceUrl !== undefined) {
          throw new Error('--source-url requires an external --source-type');
        }
        doc.code = { owner: identity.owner, repo: identity.repo };
        doc.content = { source };
        if (options.profile !== undefined) {
          const profile = identifier(options.profile, 'profile');
          if (!Object.hasOwn(model.profiles, profile)) {
            throw new Error('Referenced profile does not exist');
          }
          doc.extends = { profile };
        }
        model.sites[name] = { doc, query: null, sitemap: null };
      } else {
        model.profiles[name] = { doc, query: null };
      }
      directories.add(dir);
      files.set(`${dir}/${this.kind}.json`, { content: json(doc) });
    }
    if (!files.has('org/users.json')) {
      files.set('org/users.json', { content: json([]) });
    }
    validateModel(model, true, false);
    await installTree(this.directory, previous, files, directories);
    this.log.info(`Added ${this.kind} ${name} to site-config/`);
    if (!model.users.some((user) => user.roles.includes('admin')) || !Object.keys(model.sites).length) {
      this.log.warn('Before deploying, add at least one site and an organisation user with the admin role.');
    }
  }
}
