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
import deploy from './deploy.js';
import resource from './add.js';
import importConfig from './import.js';

export default function config() {
  return {
    command: 'config',
    description: 'Manage repository-owned AEM configuration',
    builder: (yargs) => yargs
      .command(deploy())
      .command(resource('site'))
      .command(resource('profile'))
      .command(resource('user'))
      .command(importConfig())
      .demandCommand(1, 'You need at least one config subcommand.')
      .help(),
    handler: () => {},
  };
}
