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
import { AbstractCommand } from '../abstract.cmd.js';
import AdminApi from './admin-api.js';
import { loadConfig, configEnvironment, prepareConfig } from './config-model.js';
import { syncConfig } from './config-sync.js';

export default class DeployCommand extends AbstractCommand {
  constructor(logger) {
    super(logger);
    this._dryRun = false;
    this._prune = false;
  }

  withDryRun(dryRun) {
    this._dryRun = dryRun;
    return this;
  }

  withPrune(prune) {
    this._prune = prune;
    return this;
  }

  async run() {
    const root = path.resolve(this.directory);
    const env = await configEnvironment(root);
    const model = prepareConfig(await loadConfig(root), env);
    const api = new AdminApi({
      token: env.AEM_ADMIN_TOKEN,
      base: env.AEM_ADMIN_BASE,
      log: this.log,
    });
    await syncConfig(api, model, {
      dryRun: this._dryRun,
      prune: this._prune,
      log: this.log,
    });
  }
}
