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
import { configIdentity, configEnvironment } from './config-model.js';
import AdminApi from './admin-api.js';
import { importSnapshot } from './config-import.js';
import ConfigPrompts from './config-prompts.js';
import { readTree, fileChanges, installTree } from './config-files.js';

export default class ImportCommand extends AbstractCommand {
  constructor(log) {
    super(log);
    this.prompts = new ConfigPrompts(this.log);
  }

  withOptions(options) {
    this.options = options;
    return this;
  }

  async run() {
    const previous = await readTree(this.directory);
    const { org } = await configIdentity(this.directory);
    const env = await configEnvironment(this.directory);
    const api = this.api || new AdminApi({
      token: env.AEM_ADMIN_TOKEN, base: env.AEM_ADMIN_BASE, log: this.log,
    });
    const snapshot = await importSnapshot(api, org);
    const changes = fileChanges(previous.files, snapshot.files);
    const options = this.options || {};
    this.log.info(`Import organisation ${org}: ${snapshot.model.users.length} users, `
      + `${Object.keys(snapshot.model.profiles).length} profiles, `
      + `${Object.keys(snapshot.model.sites).length} sites`);
    for (const change of changes) {
      this.log.info(`  ${change}`);
    }
    if (snapshot.variables.length) {
      this.log.warn(`Supply these environment variables before deploy: ${snapshot.variables.join(', ')}`);
    }
    if (options.dryRun) {
      this.log.info('Dry run: no local files written.');
      return;
    }
    if (!changes.length) {
      this.log.info('No local config changes.');
      return;
    }
    if (previous.version !== 'missing') {
      if (!options.overwrite) {
        throw new Error('site-config/ exists; use --overwrite to replace it after reviewing the preview');
      }
      await this.prompts.confirm('Replace site-config/ with the displayed imported configuration?', options.yes);
    }
    await installTree(this.directory, previous, snapshot.files, snapshot.directories);
    this.log.info('Imported deployed configuration into site-config/. No live configuration changed.');
  }
}
